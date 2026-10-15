//! Automatic re-identification: notices when a new song starts and
//! fingerprints it, so lyrics follow a playlist without pressing 🎧.
//!
//! Two triggers, both off the capture loudness (`audio::level`):
//! - **After a gap.** A run of silence (track gap, pause, ad break) followed by
//!   enough continuous sound to fingerprint means a song (re)started.
//! - **Periodic check.** Crossfaded/gapless playlists have no gap, so while
//!   sound keeps playing we re-check every so often — and sooner right after
//!   a change, since what we matched may have been an ad running straight
//!   into the song.
//!
//! Attempts are silent and only announce a result when the song changed (see
//! `identify::identify` with `auto = true`).

use crate::{audio, identify};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Same threshold the UI uses for "something is playing".
const SILENCE_RMS: f32 = 0.002;
/// Silence at least this long counts as a gap between songs.
const GAP: Duration = Duration::from_millis(1500);
/// Sound needed after a gap before fingerprinting the new song.
const LISTEN: Duration = Duration::from_secs(9);
/// While playing with no gaps, re-check this often (crossfades).
const RECHECK: Duration = Duration::from_secs(60);
/// ...but only this long after a change, to catch ad → song with no gap.
const CONFIRM: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_millis(250);

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Turn automatic re-identification on or off (the UI remembers the choice).
#[tauri::command]
pub fn set_auto_identify(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // Start as if after a gap, so the first song gets identified too.
        let mut gap = true;
        let mut silent_since: Option<Instant> = None;
        let mut sound_since: Option<Instant> = None;

        loop {
            std::thread::sleep(TICK);
            let now = Instant::now();

            if audio::level() > SILENCE_RMS {
                silent_since = None;
                sound_since.get_or_insert(now);
            } else {
                let since = *silent_since.get_or_insert(now);
                if now - since >= GAP {
                    gap = true;
                    sound_since = None;
                }
            }

            if !ENABLED.load(Ordering::Relaxed) || identify::in_flight() {
                continue;
            }
            let Some(playing_for) = sound_since.map(|t| now - t) else { continue };
            let due = if gap {
                playing_for >= LISTEN
            } else {
                // Only once a full window of the current stretch is music.
                playing_for >= LISTEN
                    && identify::since_last_attempt().is_none_or(|t| {
                        t >= if identify::just_changed() { CONFIRM } else { RECHECK }
                    })
            };
            if !due {
                continue;
            }
            gap = false;
            if let Some((mono, rate)) = audio::id_snapshot() {
                identify::identify(app.clone(), mono, rate, true);
            }
        }
    });
}
