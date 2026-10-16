//! Windows equalizer — a bridge to Equalizer APO.
//!
//! Windows has no in-process "mute the source and re-output" seam like macOS's
//! Core Audio process tap, so a real system-wide EQ needs something sitting in
//! the audio pipeline. Equalizer APO (free, open-source) is exactly that, and
//! it hot-reloads its text config on change. So WinzAMP doesn't ship a driver:
//! its EQ sliders just write Equalizer APO's config, and WinzAMP becomes a
//! front-end over a proven engine.
//!
//! We write our own `winzamp.txt` (never clobbering the user's `config.txt`)
//! and make sure `config.txt` includes it once. "Off" writes an empty filter
//! set, so it's a clean no-op without removing the include.
#![cfg(target_os = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Classic Winamp band centers, matched to the macOS engine.
pub const BANDS: usize = 10;
const CENTERS_HZ: [u32; BANDS] = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const Q: f32 = 1.41;

/// Our managed include file, dropped next to Equalizer APO's config.txt.
const INCLUDE_FILE: &str = "winzamp.txt";

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Last gains we were asked for, so toggling on re-applies them.
static LAST: Mutex<(f32, [f32; BANDS])> = Mutex::new((0.0, [0.0; BANDS]));

pub fn is_running() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Turn the EQ on or off and apply the given gains. On failure (e.g. Equalizer
/// APO isn't installed) returns a human-readable error.
pub fn enable(on: bool, preamp_db: f32, gains_db: [f32; BANDS]) -> Result<(), String> {
    *LAST.lock().unwrap() = (preamp_db, gains_db);
    let dir = apo_config_dir().ok_or_else(|| {
        "Equalizer APO isn't installed. Get it free at https://equalizerapo.com, \
         run its Configurator for your output device, then try again."
            .to_string()
    })?;
    ensure_include(&dir)?;
    write_filters(&dir, on, preamp_db, &gains_db)?;
    ENABLED.store(on, Ordering::Relaxed);
    Ok(())
}

/// Update gains while running (no-op if the EQ is off).
pub fn set_gains(preamp_db: f32, gains_db: [f32; BANDS]) {
    *LAST.lock().unwrap() = (preamp_db, gains_db);
    if ENABLED.load(Ordering::Relaxed) {
        if let Some(dir) = apo_config_dir() {
            let _ = write_filters(&dir, true, preamp_db, &gains_db);
        }
    }
}

/// Write our filter file. When `on` is false we write an empty set so Equalizer
/// APO applies nothing, without us having to touch the include.
fn write_filters(dir: &PathBuf, on: bool, preamp_db: f32, gains_db: &[f32; BANDS]) -> Result<(), String> {
    let mut body = String::from("# Managed by WinzAMP — do not edit; overwritten when you move the sliders.\n");
    if on {
        body.push_str(&format!("Preamp: {:.1} dB\n", preamp_db));
        for i in 0..BANDS {
            body.push_str(&format!(
                "Filter {}: ON PK Fc {} Hz Gain {:.1} dB Q {}\n",
                i + 1,
                CENTERS_HZ[i],
                gains_db[i],
                Q,
            ));
        }
    } else {
        body.push_str("# EQ off.\n");
    }
    let path = dir.join(INCLUDE_FILE);
    fs::write(&path, body).map_err(|e| format!("couldn't write {}: {e}", path.display()))
}

/// Make sure config.txt pulls in our file exactly once. Never rewrites the
/// user's own lines — only appends an `Include:` if it's missing.
fn ensure_include(dir: &PathBuf) -> Result<(), String> {
    let cfg = dir.join("config.txt");
    let existing = fs::read_to_string(&cfg).unwrap_or_default();
    let has = existing
        .lines()
        .any(|l| l.trim().eq_ignore_ascii_case(&format!("Include: {INCLUDE_FILE}")));
    if has {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&format!("Include: {INCLUDE_FILE}\n"));
    fs::write(&cfg, next).map_err(|e| format!("couldn't update {}: {e}", cfg.display()))
}

/// Locate Equalizer APO's `config` directory in the usual Program Files
/// locations (its default install). A custom install path isn't handled yet —
/// if that ever matters we can read it from the registry.
fn apo_config_dir() -> Option<PathBuf> {
    for env in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(env) {
            let c = PathBuf::from(pf).join("EqualizerAPO").join("config");
            if c.is_dir() {
                return Some(c);
            }
        }
    }
    None
}
