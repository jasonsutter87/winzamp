# WinzAMP on Android — the car build

The goal: WinzAMP on a dash-mounted phone, listening to the car stereo / FM
radio through the **mic**, identifying the song and throwing synced lyrics on
screen in big, read-from-the-driver's-seat text. Same Tauri project, same
identify + lyrics pipeline — only the capture device changes.

## Why the mic (not system audio)

Android *has* a system-audio capture API (`AudioPlaybackCapture`, API 29+), but
**most music apps opt out of being captured** (Spotify, YouTube, etc. set
`allowAudioPlaybackCapture="false"`), so it can't be relied on. The mic is the
universal path — and in a car it's exactly right: it hears whatever is coming
out of the speakers, including FM radio, which publishes no metadata at all.
`shazam.rs` already fingerprints over plain HTTP, so nothing downstream changes.

The capture split lives in `src-tauri/src/audio.rs`:
- desktop → `default_output_device()` (a loopback tap on what's playing)
- Android → `default_input_device()` (the mic), with i16 samples accepted

## Prerequisites

- **Android Studio** with the SDK and **NDK** installed. Set `ANDROID_HOME`
  and `NDK_HOME` (e.g. in `~/.zshrc`).
- **JDK 17** (Android Studio bundles one; point `JAVA_HOME` at it if needed).
- **A `rustup`-managed Rust toolchain with the Android targets.** This is the
  one that bites: the desktop builds here use Homebrew's `rust`, which can't
  cross-compile to Android. Install `rustup`, then:
  ```sh
  rustup target add aarch64-linux-android armv7-linux-androideabi \
    i686-linux-android x86_64-linux-android
  ```
  Make sure `rustup`'s `cargo` is first on `PATH` for the Android build.

## Build it

```sh
npm install
npm run tauri android init     # generates src-tauri/gen/android (one time)
npm run tauri android dev      # run on a connected phone or emulator
# or:
npm run tauri android build    # produces an APK/AAB under src-tauri/gen/android
```

## Two things the first build will tell us

1. **Does this cpal fork have an Android backend?** cpal talks to Android audio
   through `oboe`/AAudio. If the fork wasn't built with Android support,
   `cargo` will complain while building `cpal` for an `*-android` target. Fix is
   either enabling the fork's Android/oboe feature or dropping to a small JNI
   `AudioRecord` shim behind `cfg(target_os = "android")` in `audio.rs`.

2. **Mic permission.** Android needs `RECORD_AUDIO`, declared *and* granted at
   runtime. After `android init`, add to
   `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.RECORD_AUDIO" />
   ```
   Then grant it at runtime. Two ways, easiest first:
   - **WebView prompt:** call `navigator.mediaDevices.getUserMedia({audio:true})`
     once from the UI (e.g. when Car mode turns on). That triggers the OS mic
     dialog; once granted, the native cpal stream can open the mic. The Tauri
     WebView may need to auto-grant the WebView-level request — check
     `tauri.conf.json` / the generated `MainActivity` if the dialog never shows.
   - **Permissions plugin:** add a Tauri mobile permissions plugin and request
     `RECORD_AUDIO` explicitly before starting capture.

   Symptom if it's missing: capture "runs" but every sample is zero — the same
   silent-tap signature as macOS without the recording permission.

## Car mode (already in)

The karaoke window has a **🚗 Car** button (`karaoke.html` + `src/karaoke.ts`):
fullscreen, big-text layout, and a screen wake-lock so the display never
sleeps. It works on the desktop today and is exactly the dash-mounted mode for
the phone — no projection to the head unit (see below), the phone *is* the
display.

## What about actual CarPlay / Android Auto?

They're **template-only** — Apple and Google only allow audio / navigation /
messaging / EV templates on the head unit. A custom lyrics canvas cannot be
projected. So the car experience is a **mounted-phone fullscreen app** (Car
mode above), not a projected one. That's a platform limit, not a TODO.
