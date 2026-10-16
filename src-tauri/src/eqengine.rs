//! Real, driver-free system-audio EQ for macOS (14.2+).
//!
//! WinzAMP normally only *taps a copy* of your audio — the original plays
//! untouched. To actually shape the sound you hear, this module briefly becomes
//! the thing that plays it:
//!
//!   system apps ─▶ Core Audio process tap (muted, excludes WinzAMP itself)
//!              ─▶ aggregate device { tap = input, real speakers = output }
//!              ─▶ one IOProc: read tap ▶ preamp + 10 biquad bands ▶ speakers
//!
//! Muting the tapped apps + WinzAMP re-outputting is what lets you hear the EQ,
//! with no BlackHole/virtual device. Excluding WinzAMP's own process from the
//! tap is what stops a feedback loop. If WinzAMP dies, macOS tears the tap down
//! and audio returns to normal on its own.
//!
//! This is additive and opt-in: nothing here runs until `enable(true, …)`.
#![cfg(target_os = "macos")]

use std::cell::UnsafeCell;
use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioDevicePropertyNominalSampleRate, kAudioEndPointDeviceIsPrivateKey,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData,
    AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBufferList, AudioTimeStamp};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

// ---------------------------------------------------------------------------
// DSP: 10-band peaking EQ + preamp (classic Winamp band centers).
// ---------------------------------------------------------------------------

pub const BANDS: usize = 10;
const CENTERS_HZ: [f32; BANDS] = [
    60.0, 170.0, 310.0, 600.0, 1000.0, 3000.0, 6000.0, 12000.0, 14000.0, 16000.0,
];
/// Peaking-filter Q. ~1.4 keeps adjacent bands from overlapping too much while
/// still letting a single slider make an audible, musical change.
const Q: f32 = 1.41;
/// Most channels we keep per-band filter history for (stereo + a little slack).
const MAX_CH: usize = 8;

/// Normalized biquad coefficients [b0, b1, b2, a1, a2] (a0 folded in).
type Biquad = [f32; 5];

#[derive(Clone, Copy)]
struct Coeffs {
    preamp: f32, // linear gain applied before the bands
    band: [Biquad; BANDS],
}

impl Coeffs {
    /// Flat: unity preamp, every band a pass-through (b0 = 1).
    fn flat() -> Self {
        let mut band = [[0.0; 5]; BANDS];
        for b in band.iter_mut() {
            b[0] = 1.0;
        }
        Coeffs { preamp: 1.0, band }
    }

    fn compute(fs: f32, preamp_db: f32, gains_db: &[f32; BANDS]) -> Self {
        let mut band = [[0.0; 5]; BANDS];
        for i in 0..BANDS {
            band[i] = peaking(fs, CENTERS_HZ[i], Q, gains_db[i]);
        }
        Coeffs {
            preamp: 10f32.powf(preamp_db / 20.0),
            band,
        }
    }
}

/// RBJ cookbook peaking-EQ coefficients, normalized by a0.
fn peaking(fs: f32, f0: f32, q: f32, gain_db: f32) -> Biquad {
    use std::f32::consts::PI;
    let a = 10f32.powf(gain_db / 40.0);
    let w0 = 2.0 * PI * (f0 / fs);
    let (sin, cos) = (w0.sin(), w0.cos());
    let alpha = sin / (2.0 * q);

    let b0 = 1.0 + alpha * a;
    let b1 = -2.0 * cos;
    let b2 = 1.0 - alpha * a;
    let a0 = 1.0 + alpha / a;
    let a1 = -2.0 * cos;
    let a2 = 1.0 - alpha / a;
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

/// Per-channel, per-band filter history (transposed Direct Form II).
struct Dsp {
    z: [[(f32, f32); BANDS]; MAX_CH],
}

impl Dsp {
    fn new() -> Self {
        Dsp {
            z: [[(0.0, 0.0); BANDS]; MAX_CH],
        }
    }

    #[inline]
    fn run(&mut self, coeffs: &Coeffs, ch: usize, x: f32) -> f32 {
        let mut s = x * coeffs.preamp;
        for b in 0..BANDS {
            let c = &coeffs.band[b];
            let st = &mut self.z[ch][b];
            let y = c[0] * s + st.0;
            st.0 = c[1] * s - c[3] * y + st.1;
            st.1 = c[2] * s - c[4] * y;
            s = y;
        }
        // Protect the speakers: boosted bands can exceed full scale.
        s.clamp(-1.0, 1.0)
    }
}

// ---------------------------------------------------------------------------
// Engine: owns the CoreAudio objects and the DSP, lives behind a static.
// ---------------------------------------------------------------------------

struct Engine {
    tap_id: AudioObjectID,
    agg_id: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    /// Output device sample rate, used when (re)computing band coefficients.
    fs: f32,
    /// Control thread writes (on slider changes); the IOProc copies it out.
    coeffs: Mutex<Coeffs>,
    /// Last coeffs the IOProc successfully read — used when `coeffs` is locked,
    /// so a slider move never blocks or glitches the audio thread.
    last: UnsafeCell<Coeffs>,
    /// Filter history, touched only by the IOProc.
    dsp: UnsafeCell<Dsp>,
}

// The UnsafeCells are only ever touched on the single realtime IOProc thread;
// everything else goes through `coeffs` (a Mutex). Safe to share the pointer.
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}

static ENGINE: Mutex<Option<Box<Engine>>> = Mutex::new(None);

/// True while the EQ is actively in the audio path.
pub fn is_running() -> bool {
    ENGINE.lock().unwrap().is_some()
}

/// Turn the EQ on or off. When turning on (or already on) it also applies the
/// given gains. Idempotent; returns a human-readable error on failure.
pub fn enable(on: bool, preamp_db: f32, gains_db: [f32; BANDS]) -> Result<(), String> {
    let mut slot = ENGINE.lock().unwrap();
    if on {
        if slot.is_none() {
            *slot = Some(start()?);
        }
        if let Some(eng) = slot.as_ref() {
            *eng.coeffs.lock().unwrap() = Coeffs::compute(eng.fs, preamp_db, &gains_db);
        }
        Ok(())
    } else {
        if let Some(eng) = slot.take() {
            eng.stop();
        }
        Ok(())
    }
}

/// Update gains while running (no-op if the EQ is off).
pub fn set_gains(preamp_db: f32, gains_db: [f32; BANDS]) {
    if let Some(eng) = ENGINE.lock().unwrap().as_ref() {
        *eng.coeffs.lock().unwrap() = Coeffs::compute(eng.fs, preamp_db, &gains_db);
    }
}

impl Engine {
    fn stop(&self) {
        unsafe {
            if self.proc_id.is_some() {
                AudioDeviceStop(self.agg_id, self.proc_id);
                AudioDeviceDestroyIOProcID(self.agg_id, self.proc_id);
            }
            AudioHardwareDestroyAggregateDevice(self.agg_id);
            AudioHardwareDestroyProcessTap(self.tap_id);
        }
    }
}

// ---------------------------------------------------------------------------
// IOProc: the realtime callback. Reads the tap, runs the EQ, writes speakers.
// ---------------------------------------------------------------------------

unsafe extern "C-unwind" fn io_proc(
    _in_device: AudioObjectID,
    _in_now: NonNull<AudioTimeStamp>,
    in_input: NonNull<AudioBufferList>,
    _in_input_time: NonNull<AudioTimeStamp>,
    out_output: NonNull<AudioBufferList>,
    _in_output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    if client.is_null() {
        return 0;
    }
    let eng = &*(client as *const Engine);

    // Grab coeffs without blocking the audio thread: try the lock, else reuse
    // the last good copy.
    let coeffs = match eng.coeffs.try_lock() {
        Ok(g) => {
            let v = *g;
            *eng.last.get() = v;
            v
        }
        Err(_) => *eng.last.get(),
    };
    let dsp = &mut *eng.dsp.get();

    let inl = &*in_input.as_ptr();
    let outl = &mut *out_output.as_ptr();
    let n_in = inl.mNumberBuffers as usize;
    let n_out = outl.mNumberBuffers as usize;
    let in_bufs = std::slice::from_raw_parts(inl.mBuffers.as_ptr(), n_in);
    let out_bufs = std::slice::from_raw_parts_mut(outl.mBuffers.as_mut_ptr(), n_out);

    // Walk output buffers; map each to the input buffer at the same index (the
    // common case: tap and device share a layout). `ch_base` gives each channel
    // a stable index so its biquad history is continuous.
    let mut ch_base = 0usize;
    for b in 0..n_out {
        let ob = &mut out_bufs[b];
        let ch = (ob.mNumberChannels as usize).max(1);
        let out_n = ob.mDataByteSize as usize / 4;
        let dst = ob.mData as *mut f32;
        if dst.is_null() {
            ch_base += ch;
            continue;
        }

        if b < n_in && !in_bufs[b].mData.is_null() {
            let ib = &in_bufs[b];
            let in_n = ib.mDataByteSize as usize / 4;
            let src = ib.mData as *const f32;
            let n = out_n.min(in_n);
            for i in 0..n {
                let c = (ch_base + (i % ch)).min(MAX_CH - 1);
                *dst.add(i) = dsp.run(&coeffs, c, *src.add(i));
            }
            for i in n..out_n {
                *dst.add(i) = 0.0; // output longer than input: pad with silence
            }
        } else {
            for i in 0..out_n {
                *dst.add(i) = 0.0; // no matching input: silence, never garbage
            }
        }
        ch_base += ch;
    }
    0
}

// ---------------------------------------------------------------------------
// Setup: build the tap + aggregate and start the IOProc.
// ---------------------------------------------------------------------------

fn start() -> Result<Box<Engine>, String> {
    unsafe {
        let output = default_output_device()?;
        let output_uid = device_uid(output)?;
        let fs = nominal_sample_rate(output).unwrap_or(48000.0);

        // 1. Tap: stereo, global, but exclude WinzAMP's own process so our
        //    re-output is never re-tapped (no feedback). Muted so the tapped
        //    apps don't also play directly — WinzAMP becomes their output.
        let exclude = self_process_exclusion();
        let tap_desc = CATapDescription::initStereoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &exclude,
        );
        tap_desc.setMuteBehavior(CATapMuteBehavior::Muted);
        tap_desc.setName(&NSString::from_str("WinzAMP EQ"));
        tap_desc.setPrivate(true);

        let mut tap_id: AudioObjectID = 0;
        let status =
            AudioHardwareCreateProcessTap(Some(tap_desc.as_ref()), &mut tap_id);
        if status != 0 {
            return Err(format!("couldn't create audio tap (status {status})"));
        }
        let tap_uid = tap_desc.UUID().UUIDString();

        // 2. Aggregate device: the muted tap as input, the real speakers as the
        //    output (and clock master). One IOProc then reads one, writes the other.
        let props = aggregate_properties(tap_uid, &output_uid);
        let mut agg_id: AudioObjectID = 0;
        let status =
            AudioHardwareCreateAggregateDevice(props.as_ref(), NonNull::from(&mut agg_id));
        if status != 0 {
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!("couldn't create aggregate device (status {status})"));
        }

        // 3. Box the engine first so the client pointer we hand the IOProc is
        //    stable for the IOProc's whole life.
        let eng = Box::new(Engine {
            tap_id,
            agg_id,
            proc_id: None,
            fs,
            coeffs: Mutex::new(Coeffs::flat()),
            last: UnsafeCell::new(Coeffs::flat()),
            dsp: UnsafeCell::new(Dsp::new()),
        });
        let client = &*eng as *const Engine as *mut c_void;

        let mut proc_id: AudioDeviceIOProcID = None;
        let status = AudioDeviceCreateIOProcID(
            agg_id,
            Some(io_proc),
            client,
            NonNull::from(&mut proc_id),
        );
        if status != 0 || proc_id.is_none() {
            AudioHardwareDestroyAggregateDevice(agg_id);
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!("couldn't create IOProc (status {status})"));
        }

        let status = AudioDeviceStart(agg_id, proc_id);
        if status != 0 {
            AudioDeviceDestroyIOProcID(agg_id, proc_id);
            AudioHardwareDestroyAggregateDevice(agg_id);
            AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!("couldn't start audio engine (status {status})"));
        }

        // Store the real proc_id (DSP/coeffs stay flat until the caller applies
        // gains right after this returns).
        let mut eng = eng;
        eng.proc_id = proc_id;
        Ok(eng)
    }
}

/// WinzAMP's own audio process object, wrapped as the exclude-list the tap
/// wants. Empty if we can't resolve it (the tap then captures everything; the
/// aggregate routing usually still avoids feedback, but we prefer excluding).
unsafe fn self_process_exclusion() -> Retained<NSArray<NSNumber>> {
    let pid = std::process::id() as i32;
    let mut proc_obj: AudioObjectID = 0;
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject as AudioObjectID,
        NonNull::from(&addr),
        std::mem::size_of::<i32>() as u32,
        NonNull::from(&pid).as_ptr().cast(),
        NonNull::from(&mut size),
        NonNull::from(&mut proc_obj).cast(),
    );
    if status == 0 && proc_obj != 0 {
        let num = NSNumber::numberWithUnsignedInt(proc_obj);
        NSArray::from_retained_slice(&[num])
    } else {
        NSArray::new()
    }
}

unsafe fn default_output_device() -> Result<AudioObjectID, String> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut id: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject as AudioObjectID,
        NonNull::from(&addr),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::from(&mut id).cast(),
    );
    if status != 0 || id == 0 {
        return Err(format!("no default output device (status {status})"));
    }
    Ok(id)
}

unsafe fn device_uid(device: AudioObjectID) -> Result<Retained<NSString>, String> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut cfstr: *mut c_void = std::ptr::null_mut();
    let mut size = std::mem::size_of::<*mut c_void>() as u32;
    let status = AudioObjectGetPropertyData(
        device,
        NonNull::from(&addr),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::from(&mut cfstr).cast(),
    );
    if status != 0 || cfstr.is_null() {
        return Err(format!("couldn't read device UID (status {status})"));
    }
    Retained::retain(cfstr as *mut NSString).ok_or_else(|| "null device UID".into())
}

unsafe fn nominal_sample_rate(device: AudioObjectID) -> Option<f32> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut rate: f64 = 0.0;
    let mut size = std::mem::size_of::<f64>() as u32;
    let status = AudioObjectGetPropertyData(
        device,
        NonNull::from(&addr),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::from(&mut rate).cast(),
    );
    if status == 0 && rate > 0.0 {
        Some(rate as f32)
    } else {
        None
    }
}

// --- CoreFoundation dictionary plumbing for the aggregate device -----------

fn to_cfstring(cstr: &CStr) -> CFRetained<CFString> {
    unsafe { CFString::with_c_string(kCFAllocatorDefault, cstr.as_ptr(), 0x0800_0100 /* UTF8 */) }
        .unwrap()
}

/// Build the aggregate-device properties: a private aggregate whose output is
/// the real speakers (main sub-device) and whose input is our muted tap.
unsafe fn aggregate_properties(
    tap_uid: Retained<NSString>,
    output_uid: &NSString,
) -> CFRetained<CFDictionary> {
    // Sub-tap entry: our tap UID, with drift compensation on.
    let tap_entry = {
        let d = CFMutableDictionary::new(
            kCFAllocatorDefault,
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();
        CFMutableDictionary::set_value(
            Some(d.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(d.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        d
    };
    let taps_arr = {
        let list = [tap_entry];
        CFArray::new(
            kCFAllocatorDefault,
            list.as_ptr() as *mut *const c_void,
            list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };

    // Sub-device entry: the real output device, by UID.
    let sub_entry = {
        let d = CFMutableDictionary::new(
            kCFAllocatorDefault,
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();
        CFMutableDictionary::set_value(
            Some(d.as_ref()),
            &*to_cfstring(kAudioSubDeviceUIDKey) as *const _ as *const c_void,
            output_uid as *const _ as *const c_void,
        );
        d
    };
    let subs_arr = {
        let list = [sub_entry];
        CFArray::new(
            kCFAllocatorDefault,
            list.as_ptr() as *mut *const c_void,
            list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };

    let pid = std::process::id();
    let dict = CFMutableDictionary::new(
        kCFAllocatorDefault,
        7,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks,
    )
    .unwrap();
    let set = |k: &CStr, v: *const c_void| {
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(k) as *const _ as *const c_void,
            v,
        );
    };
    set(
        kAudioAggregateDeviceNameKey,
        &*CFString::from_str("WinzAMP EQ Device") as *const _ as *const c_void,
    );
    set(
        kAudioAggregateDeviceUIDKey,
        &*CFString::from_str(&format!("com.jasonsutter.winzamp.eq.{pid}")) as *const _
            as *const c_void,
    );
    set(
        kAudioAggregateDeviceMainSubDeviceKey,
        output_uid as *const _ as *const c_void,
    );
    set(
        kAudioAggregateDeviceSubDeviceListKey,
        &*subs_arr as *const _ as *const c_void,
    );
    set(
        kAudioAggregateDeviceTapListKey,
        &*taps_arr as *const _ as *const c_void,
    );
    set(
        kAudioAggregateDeviceTapAutoStartKey,
        &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
    );
    set(
        kAudioEndPointDeviceIsPrivateKey,
        &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
    );

    CFRetained::cast_unchecked::<CFDictionary>(dict)
}
