//! System-audio pass-through. Taps whatever the Mac is playing (cpal opens an
//! input stream on the default *output* device, which on macOS 14.6+ builds a
//! Core Audio process tap), keeps the last FFT_SIZE stereo frames, and pushes
//! a visualizer frame to every window ~60 times a second.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Butterchurn (Milkdrop) wants exactly 1024 time-domain samples per channel.
pub const FFT_SIZE: usize = 1024;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
/// dB floor for the spectrum; anything quieter reads as 0.
const DB_FLOOR: f32 = -70.0;

#[derive(Clone, Serialize)]
pub struct Frame {
    /// Left/right waveform, unsigned 8-bit centered on 128 (WebAudio's
    /// getByteTimeDomainData shape, which Butterchurn consumes directly).
    pub l: Vec<u8>,
    pub r: Vec<u8>,
    /// FFT_SIZE/2 magnitude bins, 0..=255 mapped from DB_FLOOR..0 dB.
    pub spec: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct CaptureInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// How many seconds of mono audio to keep for song identification.
pub const ID_SECONDS: usize = 12;

/// Stereo FFT ring (newest FFT_SIZE frames) plus a longer rolling mono buffer
/// used for fingerprinting. Both live under one lock so the audio callback
/// takes only a single mutex.
struct Ring {
    l: [f32; FFT_SIZE],
    r: [f32; FFT_SIZE],
    pos: usize,
    id: std::collections::VecDeque<f32>,
    id_cap: usize,
    rate: u32,
}

impl Ring {
    fn push(&mut self, l: f32, r: f32) {
        self.l[self.pos] = l;
        self.r[self.pos] = r;
        self.pos = (self.pos + 1) % FFT_SIZE;

        self.id.push_back((l + r) * 0.5);
        if self.id.len() > self.id_cap {
            self.id.pop_front();
        }
    }

    fn snapshot(&self) -> (Vec<f32>, Vec<f32>) {
        let unroll = |buf: &[f32; FFT_SIZE]| {
            let mut v = Vec::with_capacity(FFT_SIZE);
            v.extend_from_slice(&buf[self.pos..]);
            v.extend_from_slice(&buf[..self.pos]);
            v
        };
        (unroll(&self.l), unroll(&self.r))
    }

    fn id_snapshot(&self) -> (Vec<f32>, u32) {
        (self.id.iter().copied().collect(), self.rate)
    }
}

use std::sync::OnceLock;

/// Shared handle to the capture buffers, so the identify command can grab a
/// fingerprinting sample without owning the stream.
static BUFFERS: OnceLock<Arc<Mutex<Ring>>> = OnceLock::new();

/// The last ~`ID_SECONDS` of mono audio and its sample rate, if capture is up.
pub fn id_snapshot() -> Option<(Vec<f32>, u32)> {
    BUFFERS.get().map(|b| b.lock().unwrap().id_snapshot())
}

/// Spawns the capture thread. It owns the cpal stream for the life of the app.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = run(&app) {
            eprintln!("capture failed: {e:#}");
            let _ = app.emit("capture-error", format!("{e:#}"));
        }
    });
}

fn run(app: &AppHandle) -> anyhow::Result<()> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no output device found"))?;
    let supported = device.default_output_config()?;
    if supported.sample_format() != SampleFormat::F32 {
        anyhow::bail!("unsupported sample format: {:?}", supported.sample_format());
    }
    let channels = supported.channels() as usize;
    let info = CaptureInfo {
        device: device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "System output".into()),
        sample_rate: supported.sample_rate(),
        channels: supported.channels(),
    };
    let config: cpal::StreamConfig = supported.into();

    let id_cap = info.sample_rate as usize * ID_SECONDS;
    let ring = Arc::new(Mutex::new(Ring {
        l: [0.0; FFT_SIZE],
        r: [0.0; FFT_SIZE],
        pos: 0,
        id: std::collections::VecDeque::with_capacity(id_cap + 1),
        id_cap,
        rate: info.sample_rate,
    }));
    let _ = BUFFERS.set(ring.clone());

    let writer = ring.clone();
    let stream = device.build_input_stream(
        config,
        move |data: &[f32], _| {
            let mut ring = writer.lock().unwrap();
            for frame in data.chunks_exact(channels) {
                let l = frame[0];
                let r = if channels > 1 { frame[1] } else { l };
                ring.push(l, r);
            }
        },
        |e| eprintln!("audio stream error: {e}"),
        None,
    )?;
    stream.play()?;
    let _ = app.emit("capture-started", info.clone());
    *app_info().lock().unwrap() = Some(info);

    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos()
        })
        .collect();
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];

    loop {
        let (l, r) = ring.lock().unwrap().snapshot();

        for (i, slot) in buf.iter_mut().enumerate() {
            *slot = Complex::new((l[i] + r[i]) * 0.5 * hann[i], 0.0);
        }
        fft.process(&mut buf);
        // Hann window halves the coherent gain, so a full-scale sine peaks near N/4.
        let norm = FFT_SIZE as f32 / 4.0;
        let spec = buf[..FFT_SIZE / 2]
            .iter()
            .map(|c| {
                let db = 20.0 * (c.norm() / norm + 1e-9).log10();
                ((db - DB_FLOOR) / -DB_FLOOR * 255.0).clamp(0.0, 255.0) as u8
            })
            .collect();

        let to_u8 = |s: &f32| ((s.clamp(-1.0, 1.0) * 127.0) + 128.0) as u8;
        let frame = Frame {
            l: l.iter().map(to_u8).collect(),
            r: r.iter().map(to_u8).collect(),
            spec,
        };
        let _ = app.emit("frame", frame);
        std::thread::sleep(FRAME_INTERVAL);
    }
}

/// Last known capture info, so windows opened later can ask for it.
pub fn app_info() -> &'static Mutex<Option<CaptureInfo>> {
    static INFO: Mutex<Option<CaptureInfo>> = Mutex::new(None);
    &INFO
}
