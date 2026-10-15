//! Now Playing bridge. Spawns `/usr/bin/perl` (an Apple platform binary) to
//! load our MediaRemote dylib, then reads one JSON line per change from its
//! stdout and re-emits it to the UI as a "nowplaying" event.
//!
//! Why perl: since macOS 15.4 the MediaRemote daemon answers Now Playing
//! queries only for Apple-signed platform binaries. A Tauri app is not one;
//! perl is. perl loading our dylib via DynaLoader is the supported seam, and
//! it also avoids SIP's DYLD_INSERT restriction (no injection — perl opts in).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// One Now Playing snapshot, as the dylib prints it. Deserialized opaquely and
/// forwarded; the shape is mirrored in the frontend's NowPlaying type.
#[derive(Clone, Serialize, Deserialize)]
pub struct NowPlaying {
    pub playing: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub elapsed: f64,
    pub duration: f64,
    pub rate: f64,
}

// Both are embedded so a packaged app (e.g. a .dmg built elsewhere) carries
// them; the dylib is unpacked to a temp file because perl loads it by path.
const DYLIB: &[u8] = include_bytes!(env!("NOWPLAYING_DYLIB"));
const LOADER: &str = include_str!("../bridge/load.pl");

/// Unpack the bridge dylib (once per version) and return its path. Written to
/// a temp name and renamed, so a half-written file is never loaded.
fn dylib_path() -> std::io::Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("winzamp-nowplaying-{}.dylib", env!("CARGO_PKG_VERSION")));
    if std::fs::read(&path).ok().as_deref() != Some(DYLIB) {
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, DYLIB)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

/// Last snapshot, so a window opened later (e.g. karaoke) gets the current
/// track immediately instead of waiting for the next change.
pub fn last() -> &'static Mutex<Option<NowPlaying>> {
    static LAST: Mutex<Option<NowPlaying>> = Mutex::new(None);
    &LAST
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = run(&app) {
            eprintln!("nowplaying bridge: {e}");
            let _ = app.emit("nowplaying-error", e.to_string());
        }
    });
}

fn run(app: &AppHandle) -> anyhow::Result<()> {
    let mut child = Command::new("/usr/bin/perl")
        .arg("-e")
        .arg(LOADER)
        .arg(dylib_path()?)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout from perl bridge"))?;

    for line in BufReader::new(stdout).lines() {
        let line = line?;
        match serde_json::from_str::<NowPlaying>(&line) {
            Ok(np) => {
                *last().lock().unwrap() = Some(np.clone());
                let _ = app.emit("nowplaying", np);
            }
            Err(e) => eprintln!("nowplaying bridge: bad line {line:?}: {e}"),
        }
    }

    let status = child.wait()?;
    anyhow::bail!("perl bridge exited: {status}");
}
