mod audio;
mod autoid;
mod identify;
mod shazam;
mod volume;
#[cfg(target_os = "macos")]
mod eqengine;
#[cfg(target_os = "macos")]
mod nowplaying;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn capture_info() -> Option<audio::CaptureInfo> {
    audio::app_info().lock().unwrap().clone()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn now_playing() -> Option<nowplaying::NowPlaying> {
    nowplaying::last().lock().unwrap().clone()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn now_playing() -> Option<()> {
    None
}

/// Opens (or focuses) the Milkdrop window. Must be async: building a window
/// from a sync command deadlocks the main thread on Windows (WebView2).
#[tauri::command]
async fn open_milkdrop(app: AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("milkdrop") {
        return win.set_focus();
    }
    WebviewWindowBuilder::new(&app, "milkdrop", WebviewUrl::App("milkdrop.html".into()))
        .title("WinzAMP — Milkdrop")
        .inner_size(800.0, 600.0)
        .min_inner_size(320.0, 240.0)
        .build()?;
    Ok(())
}

#[tauri::command]
async fn open_eq(app: AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("eq") {
        return win.set_focus();
    }
    WebviewWindowBuilder::new(&app, "eq", WebviewUrl::App("eq.html".into()))
        .title("WinzAMP — Equalizer")
        .inner_size(480.0, 300.0)
        .min_inner_size(420.0, 260.0)
        .build()?;
    Ok(())
}

/// Identify the song currently coming through the speakers (Shazam, or
/// ACRCloud if configured), then emit it as an `identified` event so the
/// lyrics pipeline picks it up.
#[tauri::command]
fn identify_song(app: AppHandle) -> Result<(), String> {
    let Some((mono, rate)) = audio::id_snapshot() else {
        return Err("no audio captured yet — play something first".into());
    };
    // Need a few seconds of sound; silence won't fingerprint. Dead-zero energy
    // means the capture tap is handing us silence — almost always because macOS
    // hasn't granted System Audio Recording — so say that instead of "turn it up".
    let energy: f32 = mono.iter().map(|s| s.abs()).sum::<f32>() / mono.len().max(1) as f32;
    if energy < 0.0005 {
        let message = if energy < 1e-6 {
            "No audio is reaching WinzAMP. Enable System Audio Recording for WinzAMP in System Settings → Privacy & Security, then relaunch."
        } else {
            "It's too quiet to identify — turn it up."
        };
        let _ = app.emit(
            "identify-status",
            serde_json::json!({ "stage": "error", "message": message }),
        );
        return Err("no capture".into());
    }
    let _ = app.emit(
        "identify-status",
        serde_json::json!({ "stage": "listening", "message": "Listening…" }),
    );
    identify::identify(app, mono, rate, false);
    Ok(())
}

/// Press a system media key, so the skin's transport buttons drive whatever
/// is playing (YouTube, Spotify, ...). `key`: "playpause" | "next" | "prev" | "stop".
#[tauri::command]
fn media_key(key: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
        let vk = match key {
            "playpause" => VK_MEDIA_PLAY_PAUSE,
            "next" => VK_MEDIA_NEXT_TRACK,
            "prev" => VK_MEDIA_PREV_TRACK,
            "stop" => VK_MEDIA_STOP,
            _ => return Err(format!("unknown media key: {key}")),
        };
        let press = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        };
        let inputs = [press(0), press(KEYEVENTF_KEYUP)];
        let sent = unsafe {
            SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32)
        };
        if sent as usize != inputs.len() {
            return Err("SendInput was blocked".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        Err("media keys are only wired up on Windows".into())
    }
}

/// Opens (or focuses) the full-screen karaoke window. Async for the same
/// reason as `open_milkdrop`.
#[tauri::command]
async fn open_karaoke(app: AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("karaoke") {
        return win.set_focus();
    }
    WebviewWindowBuilder::new(&app, "karaoke", WebviewUrl::App("karaoke.html".into()))
        .title("WinzAMP — Karaoke")
        .inner_size(900.0, 560.0)
        .min_inner_size(480.0, 320.0)
        .build()?;
    Ok(())
}

// --- Equalizer -------------------------------------------------------------
// Real, driver-free system EQ (macOS only). `bands` is 10 gains in dB (classic
// Winamp centers); `preamp` is an overall gain in dB.

#[cfg(target_os = "macos")]
fn to_bands(bands: &[f32]) -> Result<[f32; eqengine::BANDS], String> {
    bands
        .try_into()
        .map_err(|_| format!("expected {} band gains", eqengine::BANDS))
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn eq_enable(on: bool, preamp: f32, bands: Vec<f32>) -> Result<(), String> {
    eqengine::enable(on, preamp, to_bands(&bands)?)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn eq_set(preamp: f32, bands: Vec<f32>) -> Result<(), String> {
    eqengine::set_gains(preamp, to_bands(&bands)?);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn eq_running() -> bool {
    eqengine::is_running()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn eq_enable(_on: bool, _preamp: f32, _bands: Vec<f32>) -> Result<(), String> {
    Err("the equalizer is macOS-only for now".into())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn eq_set(_preamp: f32, _bands: Vec<f32>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn eq_running() -> bool {
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            audio::start(app.handle().clone());
            autoid::start(app.handle().clone());
            #[cfg(target_os = "macos")]
            nowplaying::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_info,
            now_playing,
            identify_song,
            open_milkdrop,
            open_karaoke,
            open_eq,
            media_key,
            autoid::set_auto_identify,
            volume::get_volume,
            volume::set_volume,
            volume::set_balance,
            eq_enable,
            eq_set,
            eq_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
