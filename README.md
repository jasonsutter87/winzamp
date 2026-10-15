# WinzAMP

A modern Winamp that plays nothing itself: it taps whatever your Mac is playing
(YouTube, Spotify, Qobuz, anything) and runs classic visualizers on it.

- **Capture:** cpal loopback on the default output device → Core Audio process tap (macOS 14.6+). No APIs, no virtual audio device.
- **Classic vis:** 76×16 spectrum analyzer + oscilloscope with the default `viscolor.txt` palette. Click it to cycle.
- **Milkdrop:** Butterchurn fed the raw waveform. `→`/space next preset, `←` previous, `H` toggles auto-cycle.
- **Now Playing marquee:** real artist/title and song position for whatever is playing (YouTube, Spotify, …), read from macOS's Now Playing system.
- **Karaoke mode (🎤):** synced lyrics (LRCLIB) scrolled in time with the song.
- **Identify (🎧):** fingerprints the captured audio via Shazam (no key needed) to get the real artist/title — the universal path that also works for FM radio and on Android, where there's no Now Playing metadata to read.

## Requirements
- macOS 14.6+ (Apple Silicon or Intel), Xcode Command Line Tools (`xcode-select --install`) for `clang`
- Node 18+ and a Rust toolchain
- `/usr/bin/perl` (ships with macOS) — used by the Now Playing bridge

```sh
npm install
npm run tauri dev
```

First launch asks for **System Audio Recording** permission (in dev, macOS attributes it to your terminal/IDE).

## Classic skins (.wsz)

Right-click the main window (or **SKIN**) to pick one of 10 curated skins from
the [Winamp Skin Museum](https://skins.webamp.org/), load your own `.wsz`, or
drag one onto the window. Skins download on first use and are cached
(IndexedDB); they aren't bundled in the repo, as they're their authors' work.
The classic 275x116 main window is drawn from the skin's sprite sheets at 2x
(`src/skin.ts`, `src/skinnedPlayer.ts`); missing sheets fall back to base 2.91.

In a skin: ⏮ ▶ ❚❚ ■ ⏭ send system media keys (control YouTube, Spotify, …),
EQ opens Milkdrop, PL opens karaoke, the clutter-bar **I** identifies the song,
eject or the top-left button opens the skin menu, clicking the visualizer cycles
it. The volume and balance sliders (and the mouse wheel, for volume) drive the
real Windows output volume and left/right channel levels, and follow changes
made elsewhere. Shuffle and repeat are decorative.

## Song identification — needed for karaoke on YouTube/radio/Android

YouTube reports the whole video title as the "song" (and the channel as the
"artist"), and FM radio reports nothing at all. So lyrics lookups need the
*real* track, which we get by fingerprinting the audio we already capture.

**Works out of the box — no account or key.** By default identification uses
Shazam (`src-tauri/src/shazam.rs`): it takes the last ~12 s of captured audio,
resamples to 16 kHz, extracts spectral peaks, packs them into Shazam's
signature format and queries Shazam's recognition endpoint. The match includes
the offset into the track, used to sync the lyrics. The implementation is
written from Wang's 2003 paper and public format notes. Caveat: the endpoint is
undocumented and could change or be blocked without notice.

**Optional ACRCloud fallback.** If ACRCloud credentials are configured they're
used instead (official, paid after a 14-day trial):
- copy `src-tauri/acrcloud.example.json` to `src-tauri/acrcloud.json` (git-ignored) and fill it in, **or**
- set `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` before `npm run tauri dev`.

Click **🎧** (main window) or **🎧 Identify** (karaoke). The karaoke window
also auto-identifies when a title doesn't resolve to lyrics.

To test the Shazam path against a clip (needs network):
`SHAZAM_WAV=clip.wav cargo test --lib shazam -- --ignored --nocapture`
(16-bit mono WAV, any sample rate).

## Roadmap toward the car (Android)

The identify engine is cross-platform on purpose. The plan:
1. **Mac (done):** mic/system-audio → Shazam → LRCLIB → lyrics screen.
2. **Android build:** same Tauri project, Android target, mic capture + the
   same Shazam call. Fullscreen, big text, screen-always-on, dash-mounted.
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
5. ~~Identify by sound (Shazam; ACRCloud optional) for YouTube/radio/Android~~
6. Android build for the car (see above)
7. Vocal remover (L−R center cancel, then AI stem separation)
8. Mic pitch scoring (SingStar-style), reusing the Murmur capture path
9. ~~`.wsz` skin loading (main.bmp, viscolor.txt, etc.)~~
10. Visualizer fidelity: clean-room behavior spec of the original analyzer's binning and falloff
