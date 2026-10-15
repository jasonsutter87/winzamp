//! Song identification via Shazam's public recognition service — no account
//! or API key needed.
//!
//! Written from the published description of the algorithm (Avery Wang, "An
//! Industrial-Strength Audio Search Algorithm", ISMIR 2003) and public notes
//! on the signature wire format; no third-party implementation code is used.
//!
//! Pipeline: resample the captured mono audio to 16 kHz → short-time FFT
//! (2048-point window, 128-sample hop) → pick spectral peaks that dominate
//! their time/frequency neighbourhood → pack the peaks, grouped into four
//! frequency bands, into Shazam's binary signature → POST it to Shazam's tag
//! endpoint, which answers with the track and where in it the sample sits.
//!
//! Caveat: the endpoint is undocumented. It can change or start refusing
//! requests without notice, which is why ACRCloud remains as a fallback.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rustfft::{num_complex::Complex, FftPlanner};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const RATE: u32 = 16_000;
const WINDOW: usize = 2048;
const HOP: usize = 128;
const BINS: usize = WINDOW / 2 + 1;
/// How many past spectra the peak picker can look back over.
const HISTORY: usize = 256;
/// Shazam only uses about 12 s; more is wasted bandwidth.
const MAX_SECONDS: usize = 12;

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/// Windowed-sinc resample of `mono` (at `rate`) to 16 kHz signed 16-bit.
/// The low-pass sits at 7.2 kHz so content above Nyquist can't alias into the
/// 250–5500 Hz range the signature looks at.
fn to_16k(mono: &[f32], rate: u32) -> Vec<i16> {
    let scale = |s: f32| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
    if rate == RATE {
        return mono.iter().copied().map(scale).collect();
    }
    let step = rate as f64 / RATE as f64;
    // Cutoff in cycles per *input* sample, never above the input's own Nyquist.
    let fc = (7200.0 / rate as f64).min(0.45);
    let half = (8.0 / fc).ceil() as isize; // ~16 zero crossings of support
    let out_len = (mono.len() as f64 / step) as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let t = n as f64 * step;
        let centre = t.floor() as isize;
        let (mut acc, mut norm) = (0.0f64, 0.0f64);
        for k in (centre - half + 1)..=(centre + half) {
            if k < 0 || k as usize >= mono.len() {
                continue;
            }
            let d = t - k as f64;
            let x = 2.0 * fc * d;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
            // Blackman window over the kernel's support.
            let w = (d / half as f64 + 1.0) * 0.5;
            let blackman = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * w).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * w).cos();
            let h = sinc * blackman;
            acc += mono[k as usize] as f64 * h;
            norm += h;
        }
        out.push(scale(if norm != 0.0 { (acc / norm) as f32 } else { 0.0 }));
    }
    out
}

// ---------------------------------------------------------------------------
// Peak extraction
// ---------------------------------------------------------------------------

/// One spectral peak: when (in hops), how loud (log scale), and where (in
/// 1/64ths of an FFT bin, after parabolic interpolation).
#[derive(Clone, Copy)]
struct Peak {
    pass: u32,
    magnitude: u16,
    bin: u16,
}

/// Fixed-size history of spectra; `back(1)` is the newest.
struct History {
    rows: Vec<Vec<f32>>,
    next: usize,
}

impl History {
    fn new() -> Self {
        Self { rows: vec![vec![0.0; BINS]; HISTORY], next: 0 }
    }
    fn slot(&self, back: usize) -> usize {
        (self.next + HISTORY - back % HISTORY) % HISTORY
    }
    fn back(&self, back: usize) -> &[f32] {
        &self.rows[self.slot(back)]
    }
    fn back_mut(&mut self, back: usize) -> &mut [f32] {
        let i = self.slot(back);
        &mut self.rows[i]
    }
    fn push(&mut self, row: Vec<f32>) {
        self.rows[self.next] = row;
        self.next = (self.next + 1) % HISTORY;
    }
}

/// Log-magnitude scale used for the signature's 16-bit peak heights.
fn log_mag(power: f32) -> f32 {
    power.max(1.0 / 64.0).ln() * 1477.3 + 6144.0
}

/// Run the STFT over 16 kHz samples and return the peaks for each band.
fn extract_peaks(samples: &[i16]) -> [Vec<Peak>; 4] {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(WINDOW);
    let hann: Vec<f32> = (1..=WINDOW)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (WINDOW + 1) as f32).cos())
        .collect();

    let mut ring = [0i16; WINDOW];
    let mut ring_pos = 0usize;
    let mut spectra = History::new();
    let mut spread = History::new();
    let mut passes = 0u32; // spectra produced so far
    let mut buf = vec![Complex::new(0.0f32, 0.0); WINDOW];
    let mut bands: [Vec<Peak>; 4] = Default::default();

    for hop in samples.chunks_exact(HOP) {
        // 1. Slide the newest hop into the window and take its power spectrum.
        ring[ring_pos..ring_pos + HOP].copy_from_slice(hop);
        ring_pos = (ring_pos + HOP) % WINDOW;
        for (i, slot) in buf.iter_mut().enumerate() {
            *slot = Complex::new(ring[(ring_pos + i) % WINDOW] as f32 * hann[i], 0.0);
        }
        fft.process(&mut buf);
        let power: Vec<f32> = buf[..BINS]
            .iter()
            .map(|c| (c.norm_sqr() / (1 << 17) as f32).max(1e-10))
            .collect();

        // 2. "Spread" copy: each bin becomes the max of itself and the next
        //    two bins, and that max is also pushed back into the spread rows
        //    1, 3 and 6 hops ago. Peaks are later tested against this blurred
        //    view, so a bin only counts if it beats its whole neighbourhood.
        let mut wide = power.clone();
        for i in 0..BINS - 2 {
            wide[i] = wide[i].max(wide[i + 1]).max(wide[i + 2]);
        }
        for i in 0..BINS {
            let mut m = wide[i];
            for back in [1, 3, 6] {
                let row = spread.back_mut(back);
                m = m.max(row[i]);
                row[i] = m;
            }
        }
        spectra.push(power);
        spread.push(wide);
        passes += 1;

        // 3. Judge the spectrum from 46 hops ago, now that enough of its
        //    future is known to compare against.
        if passes < 46 {
            continue;
        }
        let cand = spectra.back(46);
        let near = spread.back(49);
        for bin in 10..1015 {
            let v = cand[bin];
            if v < 1.0 / 64.0 || v < near[bin - 1] {
                continue;
            }
            let freq_neighbours = [-10isize, -7, -4, -3, 1, 2, 5, 8]
                .iter()
                .map(|&o| near[(bin as isize + o) as usize])
                .fold(0.0f32, f32::max);
            if v <= freq_neighbours {
                continue;
            }
            // Same bin in spread rows well before and after the candidate.
            let time_neighbours = [53usize, 45, 91, 84, 77, 70, 63, 56, 42, 35, 28, 21, 14, 7]
                .iter()
                .map(|&b| spread.back(b)[bin - 1])
                .fold(freq_neighbours, f32::max);
            if v <= time_neighbours {
                continue;
            }

            // Parabolic interpolation on the log magnitudes for sub-bin accuracy.
            let here = log_mag(v);
            let below = log_mag(cand[bin - 1]);
            let above = log_mag(cand[bin + 1]);
            let curvature = here * 2.0 - below - above;
            if curvature <= 0.0 {
                continue;
            }
            let fine_bin = bin as f32 * 64.0 + (above - below) * 32.0 / curvature;
            let hz = fine_bin * (RATE as f32 / 2.0 / 1024.0 / 64.0);
            let band = match hz {
                f if f < 250.0 => continue,
                f if f < 520.0 => 0,
                f if f < 1450.0 => 1,
                f if f < 3500.0 => 2,
                f if f <= 5500.0 => 3,
                _ => continue,
            };
            bands[band].push(Peak {
                pass: passes - 46,
                magnitude: here as u16,
                bin: fine_bin as u16,
            });
        }
    }
    bands
}

// ---------------------------------------------------------------------------
// Signature encoding
// ---------------------------------------------------------------------------

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Pack peaks into Shazam's binary signature (little-endian throughout).
fn encode(bands: &[Vec<Peak>; 4], sample_count: usize) -> Vec<u8> {
    // Per-band blocks: tag, byte length, then delta-coded peaks, 4-aligned.
    let mut body = Vec::new();
    for (band, peaks) in bands.iter().enumerate() {
        if peaks.is_empty() {
            continue;
        }
        let mut block = Vec::new();
        let mut last = 0u32;
        for p in peaks {
            if p.pass - last >= 255 {
                // Gap too long for a one-byte delta: escape with an absolute pass.
                block.push(0xff);
                put32(&mut block, p.pass);
                last = p.pass;
            }
            block.push((p.pass - last) as u8);
            block.extend_from_slice(&p.magnitude.to_le_bytes());
            block.extend_from_slice(&p.bin.to_le_bytes());
            last = p.pass;
        }
        put32(&mut body, 0x6003_0040 + band as u32);
        put32(&mut body, block.len() as u32);
        body.extend_from_slice(&block);
        body.resize(body.len().next_multiple_of(4), 0);
    }

    let mut sig = Vec::with_capacity(56 + body.len());
    put32(&mut sig, 0xcafe_2580); // magic
    put32(&mut sig, 0); // CRC-32, patched below
    put32(&mut sig, body.len() as u32 + 8); // size after the header
    put32(&mut sig, 0x9411_9c00); // magic
    for _ in 0..3 {
        put32(&mut sig, 0);
    }
    put32(&mut sig, 3 << 27); // sample-rate code: 3 = 16 kHz
    for _ in 0..2 {
        put32(&mut sig, 0);
    }
    put32(&mut sig, (sample_count as f32 + RATE as f32 * 0.24) as u32);
    put32(&mut sig, (15 << 19) + 0x40000);
    put32(&mut sig, 0x4000_0000);
    put32(&mut sig, body.len() as u32 + 8);
    sig.extend_from_slice(&body);

    let crc = crc32fast::hash(&sig[8..]);
    sig[4..8].copy_from_slice(&crc.to_le_bytes());
    sig
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/// Identify `mono` (any sample rate). Returns a NowPlaying-shaped JSON value,
/// or `None` if Shazam doesn't know the song.
pub fn identify(mono: &[f32], rate: u32) -> anyhow::Result<Option<Value>> {
    let keep = rate as usize * MAX_SECONDS;
    let mono = &mono[mono.len().saturating_sub(keep)..];
    let samples = to_16k(mono, rate);
    let bands = extract_peaks(&samples);
    if bands.iter().all(Vec::is_empty) {
        return Ok(None);
    }
    let sig = encode(&bands, samples.len());
    let sample_ms = samples.len() as u64 * 1000 / RATE as u64;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;

    let url = format!(
        "https://amp.shazam.com/discovery/v5/en/US/android/-/tag/{}/{}\
         ?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3",
        uuid::Uuid::new_v4().to_string().to_uppercase(),
        uuid::Uuid::new_v4().to_string().to_uppercase(),
    );
    let body = serde_json::json!({
        "geolocation": { "altitude": 300, "latitude": 45, "longitude": 2 },
        "signature": {
            "samplems": sample_ms,
            "timestamp": now_ms,
            "uri": format!("data:audio/vnd.shazam.sig;base64,{}", STANDARD.encode(&sig)),
        },
        "timestamp": now_ms,
        "timezone": "Europe/Paris",
    });
    let resp: Value = reqwest::blocking::Client::new()
        .post(url)
        .header("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 9; SM-G960F Build/PPR1.180610.011)")
        .header("Content-Language", "en_US")
        .json(&body)
        .send()?
        .error_for_status()?
        .json()?;

    let Some(track) = resp.get("track") else { return Ok(None) };
    let title = track.get("title").and_then(Value::as_str).unwrap_or("");
    let artist = track.get("subtitle").and_then(Value::as_str).unwrap_or("");
    let album = track
        .pointer("/sections/0/metadata")
        .and_then(Value::as_array)
        .and_then(|m| m.iter().find(|e| e.get("title").and_then(Value::as_str) == Some("Album")))
        .and_then(|e| e.get("text"))
        .and_then(Value::as_str);
    // `offset` is where in the track the sample starts; we report the
    // position at the sample's end, i.e. now.
    let offset = resp.pointer("/matches/0/offset").and_then(Value::as_f64).unwrap_or(0.0);

    Ok(Some(serde_json::json!({
        "playing": true,
        "title": title,
        "artist": artist,
        "album": album,
        "elapsed": offset + sample_ms as f64 / 1000.0,
        "duration": 0.0,
        "rate": 1.0,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end against the live service. Needs network and a clip:
    /// `SHAZAM_WAV=path/to/clip.wav cargo test --lib shazam -- --ignored --nocapture`
    /// (16-bit mono PCM WAV with a plain 44-byte header, any sample rate).
    #[test]
    #[ignore]
    fn identifies_clip() {
        let path = std::env::var("SHAZAM_WAV").expect("set SHAZAM_WAV");
        let bytes = std::fs::read(path).unwrap();
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let mono: Vec<f32> = bytes[44..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
            .collect();
        let found = identify(&mono, rate).unwrap();
        println!("{found:#?}");
        assert!(found.is_some(), "no match");
    }
}
