//! System master volume and L/R balance, so the skin's sliders drive the
//! real thing.
//!
//! Windows: Core Audio's IAudioEndpointVolume on the default render device,
//! looked up fresh on every call so it follows the user switching outputs.

use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub struct Volume {
    /// 0.0..=1.0, the same scalar the Windows volume flyout shows.
    pub level: f32,
    pub muted: bool,
    /// -1.0 (left only) ..= 1.0 (right only); 0 when not stereo.
    pub balance: f32,
}

/// Balance from left/right channel levels: the louder side is the master
/// level, and the quieter side's shortfall is how far we're panned.
fn balance_of(l: f32, r: f32) -> f32 {
    let m = l.max(r);
    if m <= 0.0 {
        0.0
    } else if r < l {
        -(1.0 - r / m)
    } else {
        1.0 - l / m
    }
}

/// Left/right levels for a balance at master level `m` (the inverse of above).
fn channels_for(balance: f32, m: f32) -> (f32, f32) {
    let b = balance.clamp(-1.0, 1.0);
    (m * (1.0 - b.max(0.0)), m * (1.0 + b.min(0.0)))
}

#[cfg(windows)]
mod imp {
    use super::{balance_of, channels_for, Volume};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            // Already initialised on this thread (any mode) is fine too.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
        }
    }

    pub fn get() -> windows::core::Result<Volume> {
        let ep = endpoint()?;
        unsafe {
            let balance = if ep.GetChannelCount()? >= 2 {
                balance_of(ep.GetChannelVolumeLevelScalar(0)?, ep.GetChannelVolumeLevelScalar(1)?)
            } else {
                0.0
            };
            Ok(Volume { level: ep.GetMasterVolumeLevelScalar()?, muted: ep.GetMute()?.as_bool(), balance })
        }
    }

    /// Pan by fading the quieter channel; the master level (the louder
    /// channel) is unchanged. Changing the master later keeps the ratio.
    pub fn set_balance(balance: f32) -> windows::core::Result<()> {
        let ep = endpoint()?;
        unsafe {
            if ep.GetChannelCount()? < 2 {
                return Ok(()); // mono output: nothing to pan
            }
            let (l, r) = channels_for(balance, ep.GetMasterVolumeLevelScalar()?);
            ep.SetChannelVolumeLevelScalar(0, l, std::ptr::null())?;
            ep.SetChannelVolumeLevelScalar(1, r, std::ptr::null())?;
        }
        Ok(())
    }

    pub fn set(level: f32) -> windows::core::Result<()> {
        let ep = endpoint()?;
        unsafe {
            ep.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())?;
            // Dragging the slider up means "I want to hear it".
            if level > 0.0 {
                ep.SetMute(false, std::ptr::null())?;
            }
        }
        Ok(())
    }
}

/// Current system volume. Async so COM runs off the UI thread.
#[tauri::command]
pub async fn get_volume() -> Result<Volume, String> {
    #[cfg(windows)]
    return imp::get().map_err(|e| e.to_string());
    #[cfg(not(windows))]
    Err("system volume is only wired up on Windows".into())
}

#[tauri::command]
pub async fn set_balance(balance: f32) -> Result<(), String> {
    #[cfg(windows)]
    return imp::set_balance(balance).map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = balance;
        Err("system balance is only wired up on Windows".into())
    }
}

#[tauri::command]
pub async fn set_volume(level: f32) -> Result<(), String> {
    #[cfg(windows)]
    return imp::set(level).map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = level;
        Err("system volume is only wired up on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balance_round_trips() {
        for b in [-1.0f32, -0.5, -0.1, 0.0, 0.25, 0.8, 1.0] {
            let (l, r) = channels_for(b, 0.6);
            assert!((l.max(r) - 0.6).abs() < 1e-6, "master preserved for {b}");
            assert!((balance_of(l, r) - b).abs() < 1e-5, "{b} -> ({l}, {r})");
        }
    }
}
