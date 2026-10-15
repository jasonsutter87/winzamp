mod audio;
#[cfg(target_os = "macos")]
mod nowplaying;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// Opens (or focuses) the Milkdrop window.
#[tauri::command]
fn open_milkdrop(app: AppHandle) -> tauri::Result<()> {
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

/// Opens (or focuses) the full-screen karaoke window.
#[tauri::command]
fn open_karaoke(app: AppHandle) -> tauri::Result<()> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            audio::start(app.handle().clone());
            #[cfg(target_os = "macos")]
            nowplaying::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_info,
            now_playing,
            open_milkdrop,
            open_karaoke
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
