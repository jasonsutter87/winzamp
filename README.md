# WinzAMP

A modern Winamp that plays nothing itself: it taps whatever your Mac is playing
(YouTube, Spotify, Qobuz, anything) and runs classic visualizers on it.

- **Capture:** cpal loopback on the default output device → Core Audio process tap (macOS 14.6+). No APIs, no virtual audio device.
- **Classic vis:** 76×16 spectrum analyzer + oscilloscope with the default `viscolor.txt` palette. Click it to cycle.
- **Milkdrop:** Butterchurn fed the raw waveform. `→`/space next preset, `←` previous, `H` toggles auto-cycle.
- **Now Playing marquee:** real artist/title and song position for whatever is playing (YouTube, Spotify, …), read from macOS's Now Playing system.

## Requirements
- macOS 14.6+ (Apple Silicon or Intel), Xcode Command Line Tools (`xcode-select --install`) for `clang`
- Node 18+ and a Rust toolchain
- `/usr/bin/perl` (ships with macOS) — used by the Now Playing bridge

```sh
npm install
npm run tauri dev
```

First launch asks for **System Audio Recording** permission (in dev, macOS attributes it to your terminal/IDE).

## How Now Playing works
Since macOS 15.4 the MediaRemote daemon answers Now Playing queries only for Apple-signed *platform* binaries — a normal app bundle gets nothing back. WinzAMP's bridge (`src-tauri/bridge/`) is a small dylib loaded **by `/usr/bin/perl`** (a platform binary) via `DynaLoader`; perl choosing to load it is the supported seam and also sidesteps SIP's `DYLD_INSERT` restriction. The dylib polls MediaRemote and prints one JSON line per change; `src/nowplaying.rs` reads those lines and emits `nowplaying` events to the UI. `build.rs` compiles the dylib during `cargo build`.

## Roadmap
1. ~~Pass-through capture + classic spectrum/scope~~
2. ~~Milkdrop window~~
3. ~~Now Playing marquee via MediaRemote (perl platform-binary bridge)~~
4. **Karaoke mode:** LRCLIB synced lyrics (artist/title → `.lrc`, scrolled by song position), full-screen over Milkdrop
5. Vocal remover (L−R center cancel, then AI stem separation)
6. Mic pitch scoring (SingStar-style), reusing the Murmur capture path
7. `.wsz` skin loading (main.bmp, viscolor.txt, etc.)
8. Visualizer fidelity: clean-room behavior spec of the original analyzer's binning and falloff
