//! Now Playing bridge. Spawns `/usr/bin/perl` (an Apple platform binary) to
//! load our MediaRemote dylib, then reads one JSON line per change from its
//! stdout and re-emits it to the UI as a "nowplaying" event.
//!
//! Why perl: since macOS 15.4 the MediaRemote daemon answers Now Playing
//! queries only for Apple-signed platform binaries. A Tauri app is not one;
//! perl is. perl loading our dylib via DynaLoader is the supported seam, and
//! it also avoids SIP's DYLD_INSERT restriction (no injection — perl opts in).

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

/// One Now Playing snapshot, as the dylib prints it. Deserialized opaquely and
/// forwarded; the shape is mirrored in the frontend's NowPlaying type.
#[derive(Clone, Serialize)]
pub struct NowPlaying {
    pub playing: bool,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub elapsed: f64,
    pub duration: f64,
    pub rate: f64,
}

const DYLIB: &str = env!("NOWPLAYING_DYLIB");
const LOADER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/bridge/load.pl");

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
        .arg(LOADER)
        .arg(DYLIB)
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
                let _ = app.emit("nowplaying", np);
            }
            Err(e) => eprintln!("nowplaying bridge: bad line {line:?}: {e}"),
        }
    }

    let status = child.wait()?;
    anyhow::bail!("perl bridge exited: {status}");
}
