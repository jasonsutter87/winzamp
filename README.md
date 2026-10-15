# WinzAMP

A modern Winamp that plays nothing itself: it taps whatever your Mac is playing
(YouTube, Spotify, Qobuz, anything) and runs classic visualizers on it.

- **Capture:** cpal loopback on the default output device → Core Audio process tap (macOS 14.6+). No APIs, no virtual audio device.
- **Classic vis:** 76×16 spectrum analyzer + oscilloscope with the default `viscolor.txt` palette. Click it to cycle.
- **Milkdrop:** Butterchurn fed the raw waveform. `→`/space next preset, `←` previous, `H` toggles auto-cycle.

```sh
npm install
npm run tauri dev
```

First launch asks for **System Audio Recording** permission (in dev, macOS attributes it to your terminal).

## Roadmap
1. ~~Pass-through capture + classic spectrum/scope~~
2. ~~Milkdrop window~~
3. Now Playing marquee + transport via MediaRemote (REA: map the private framework / post-15.4 lockdown)
4. `.wsz` skin loading (main.bmp, viscolor.txt, etc.)
5. Visualizer fidelity: clean-room behavior spec of the original analyzer's binning and falloff (REA)
