//! Song identification by sound.
//!
//! Cross-platform by design: we fingerprint a short captured audio sample and
//! get back the real artist/title plus how far into the track it was (perfect
//! for syncing lyrics). This is the universal path that also works in the car
//! on Android and for FM radio, where there is no Now Playing metadata to read.
//!
//! Backends: Shazam (`shazam.rs`, free, no key) by default; ACRCloud when
//! credentials are configured.
//!
//! On a match we emit a "nowplaying"-shaped event so the existing lyrics
//! pipeline (LRCLIB) handles it with no special case. Progress and errors go
//! out as "identify-status".

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

type HmacSha1 = Hmac<Sha1>;

#[derive(Clone)]
pub struct Creds {
    pub host: String,
    pub access_key: String,
    pub access_secret: String,
}

/// Load ACRCloud credentials from the environment, falling back to a JSON file
/// (`src-tauri/acrcloud.json`, git-ignored) for convenience during dev.
pub fn load_creds() -> Option<Creds> {
    use std::env::var;
    if let (Ok(host), Ok(access_key), Ok(access_secret)) = (
        var("ACRCLOUD_HOST"),
        var("ACRCLOUD_ACCESS_KEY"),
        var("ACRCLOUD_ACCESS_SECRET"),
    ) {
        if !host.is_empty() && !access_key.is_empty() && !access_secret.is_empty() {
            return Some(Creds { host, access_key, access_secret });
        }
    }

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/acrcloud.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(Creds {
        host: v.get("host")?.as_str()?.to_string(),
        access_key: v.get("access_key")?.as_str()?.to_string(),
        access_secret: v.get("access_secret")?.as_str()?.to_string(),
    })
}

#[derive(Clone, Serialize)]
struct IdStatus {
    stage: String, // "listening" | "matching" | "matched" | "nomatch" | "error" | "unconfigured"
    message: String,
}

fn status(app: &AppHandle, stage: &str, message: impl Into<String>) {
    let _ = app.emit(
        "identify-status",
        IdStatus { stage: stage.into(), message: message.into() },
    );
}

/// Encode mono f32 samples as a 16-bit PCM WAV. ACRCloud accepts WAV directly.
fn wav_bytes(mono: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (mono.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    let mut put = |b: &[u8]| out.extend_from_slice(b);
    put(b"RIFF");
    put(&(36 + data_len).to_le_bytes());
    put(b"WAVE");
    put(b"fmt ");
    put(&16u32.to_le_bytes()); // PCM fmt chunk size
    put(&1u16.to_le_bytes()); // audio format = PCM
    put(&1u16.to_le_bytes()); // channels = mono
    put(&rate.to_le_bytes());
    put(&(rate * 2).to_le_bytes()); // byte rate = rate * blockalign
    put(&2u16.to_le_bytes()); // block align = channels * 2
    put(&16u16.to_le_bytes()); // bits per sample
    put(b"data");
    put(&data_len.to_le_bytes());
    for &s in mono {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Kick off an identification from the given sample. Results arrive as events.
/// Uses ACRCloud when credentials are configured, Shazam otherwise.
pub fn identify(app: AppHandle, mono: Vec<f32>, rate: u32) {
    std::thread::spawn(move || {
        status(&app, "matching", "Identifying…");
        let result = match load_creds() {
            Some(creds) => run(&creds, &mono, rate),
            None => crate::shazam::identify(&mono, rate),
        };
        match result {
            Ok(Some(np)) => {
                let title = np
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                status(&app, "matched", format!("Matched: {title}"));
                // Separate from "nowplaying" (MediaRemote): identification only
                // resolves the name; position may still come from Now Playing.
                let _ = app.emit("identified", np);
            }
            Ok(None) => status(&app, "nomatch", "No match — try again with the chorus playing."),
            Err(e) => status(&app, "error", format!("Identify failed: {e}")),
        }
    });
}

fn run(creds: &Creds, mono: &[f32], rate: u32) -> anyhow::Result<Option<Value>> {
    let sample = wav_bytes(mono, rate);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();

    // ACRCloud signature: HMAC-SHA1 over the canonical request string.
    let string_to_sign = format!(
        "POST\n/v1/identify\n{}\naudio\n1\n{}",
        creds.access_key, timestamp
    );
    let mut mac = HmacSha1::new_from_slice(creds.access_secret.as_bytes())
        .map_err(|_| anyhow::anyhow!("bad ACRCloud secret"))?;
    mac.update(string_to_sign.as_bytes());
    let signature = STANDARD.encode(mac.finalize().into_bytes());

    let sample_bytes = sample.len().to_string();
    let form = reqwest::blocking::multipart::Form::new()
        .text("access_key", creds.access_key.clone())
        .text("data_type", "audio")
        .text("signature_version", "1")
        .text("signature", signature)
        .text("sample_bytes", sample_bytes)
        .text("timestamp", timestamp)
        .part(
            "sample",
            reqwest::blocking::multipart::Part::bytes(sample)
                .file_name("sample.wav")
                .mime_str("audio/wav")?,
        );

    let url = format!("https://{}/v1/identify", creds.host);
    let body: Value = reqwest::blocking::Client::new()
        .post(url)
        .multipart(form)
        .send()?
        .json()?;

    let code = body
        .pointer("/status/code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if code != 0 {
        // 1001 = no result; anything else is a real error we surface.
        if code == 1001 {
            return Ok(None);
        }
        let msg = body
            .pointer("/status/msg")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        anyhow::bail!("ACRCloud status {code}: {msg}");
    }

    let music = body.pointer("/metadata/music/0");
    let Some(m) = music else { return Ok(None) };

    let title = m.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let artist = m
        .pointer("/artists/0/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let album = m.pointer("/album/name").and_then(|v| v.as_str());
    let duration = m
        .get("duration_ms")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        / 1000.0;
    let elapsed = m
        .get("play_offset_ms")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
        / 1000.0;

    // Shape matches the frontend's NowPlaying so the lyrics pipeline reuses it.
    Ok(Some(serde_json::json!({
        "playing": true,
        "title": title,
        "artist": artist,
        "album": album,
        "elapsed": elapsed,
        "duration": duration,
        "rate": 1.0,
    })))
}
