# WinzAMP

A modern Winamp that plays nothing itself: it taps whatever your Mac is playing
(YouTube, Spotify, Qobuz, anything) and runs classic visualizers on it.

- **Capture:** cpal loopback on the default output device → Core Audio process tap (macOS 14.6+). No APIs, no virtual audio device.
- **Classic vis:** 76×16 spectrum analyzer + oscilloscope with the default `viscolor.txt` palette. Click it to cycle.
- **Milkdrop:** Butterchurn fed the raw waveform. `→`/space next preset, `←` previous, `H` toggles auto-cycle.
- **Now Playing marquee:** real artist/title and song position for whatever is playing (YouTube, Spotify, …), read from macOS's Now Playing system.
- **Karaoke mode (🎤):** synced lyrics (LRCLIB) scrolled in time with the song.
- **Identify (🎧):** fingerprints the captured audio via ACRCloud to get the real artist/title — the universal path that also works for FM radio and on Android, where there's no Now Playing metadata to read.

## Requirements
- macOS 14.6+ (Apple Silicon or Intel), Xcode Command Line Tools (`xcode-select --install`) for `clang`
- Node 18+ and a Rust toolchain
- `/usr/bin/perl` (ships with macOS) — used by the Now Playing bridge

```sh
npm install
npm run tauri dev
```

First launch asks for **System Audio Recording** permission (in dev, macOS attributes it to your terminal/IDE).

## Song identification (ACRCloud) — needed for karaoke on YouTube/radio/Android

YouTube reports the whole video title as the "song" (and the channel as the
"artist"), and FM radio reports nothing at all. So lyrics lookups need the
*real* track, which we get by fingerprinting the audio we already capture.

1. Make a free account at <https://console.acrcloud.com> and create an
   **Audio & Video Recognition** project.
2. It gives you a **host**, **access key**, and **access secret**.
3. Provide them one of two ways:
   - Copy `src-tauri/acrcloud.example.json` to `src-tauri/acrcloud.json` (git-ignored) and fill it in, **or**
   - Set `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` in the environment before `npm run tauri dev`.

Then click **🎧** (main window) or **🎧 Identify** (karaoke). The karaoke window
also auto-identifies when a title doesn't resolve to lyrics. Identification
runs entirely in Rust (`src-tauri/src/identify.rs`): it grabs the last
~8 s of captured audio, encodes WAV, HMAC-signs the request, and maps the
match (including `play_offset_ms`, used to sync the lyrics) to a `nowplaying`-shaped event.

## Roadmap toward the car (Android)

The identify engine is cross-platform on purpose. The plan:
1. **Mac (done):** mic/system-audio → ACRCloud → LRCLIB → lyrics screen.
2. **Android build:** same Tauri project, Android target, mic capture + the
   same ACRCloud call. Fullscreen, big text, screen-always-on, dash-mounted.
3. Auto re-identify on song change; FM-radio friendly.

(CarPlay/Android Auto only allow template UIs in fixed app categories, so a
custom lyrics screen runs as a mounted-phone app, not a projected one.)

## How Now Playing works
Since macOS 15.4 the MediaRemote daemon answers Now Playing queries only for Apple-signed *platform* binaries — a normal app bundle gets nothing back. WinzAMP's bridge (`src-tauri/bridge/`) is a small dylib loaded **by `/usr/bin/perl`** (a platform binary) via `DynaLoader`; perl choosing to load it is the supported seam and also sidesteps SIP's `DYLD_INSERT` restriction. The dylib polls MediaRemote and prints one JSON line per change; `src/nowplaying.rs` reads those lines and emits `nowplaying` events to the UI. `build.rs` compiles the dylib during `cargo build`.

## Roadmap
1. ~~Pass-through capture + classic spectrum/scope~~
2. ~~Milkdrop window~~
3. ~~Now Playing marquee via MediaRemote (perl platform-binary bridge)~~
4. ~~Karaoke mode: LRCLIB synced lyrics scrolled by song position~~
5. ~~Identify by sound (ACRCloud) for YouTube/radio/Android~~
6. Android build for the car (see above)
7. Vocal remover (L−R center cancel, then AI stem separation)
8. Mic pitch scoring (SingStar-style), reusing the Murmur capture path
9. `.wsz` skin loading (main.bmp, viscolor.txt, etc.)
10. Visualizer fidelity: clean-room behavior spec of the original analyzer's binning and falloff
