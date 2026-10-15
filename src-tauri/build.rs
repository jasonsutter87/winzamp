// Compiles the Now Playing bridge dylib (bridge/nowplaying.m) during the build;
// the crate embeds it (include_bytes!) and unpacks it at runtime, so a
// packaged app doesn't depend on this machine's build paths.
// The linker ad-hoc-signs it, which is all MediaRemote's platform-binary gate
// needs from the *loaded* code — the trust comes from perl, the host.
use std::path::Path;
use std::process::Command;

fn main() {
    // A build script runs on the host, so ask Cargo about the *target*: this
    // matters when building the Intel app on an Apple Silicon machine.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "arm64",
            Ok("x86_64") => "x86_64",
            other => panic!("unsupported macOS arch for the Now Playing bridge: {other:?}"),
        };
        let out = std::env::var("OUT_DIR").unwrap();
        let dylib = Path::new(&out).join("libnowplaying.dylib");
        println!("cargo:rerun-if-changed=bridge/nowplaying.m");
        let status = Command::new("clang")
            .args([
                "-dynamiclib",
                "-fobjc-arc",
                "-arch",
                arch,
                "-framework",
                "Foundation",
                "-o",
            ])
            .arg(&dylib)
            .arg("bridge/nowplaying.m")
            .status()
            .expect("failed to run clang for the Now Playing bridge");
        assert!(status.success(), "bridge dylib build failed");
        // Expose the path to the crate as NOWPLAYING_DYLIB.
        println!("cargo:rustc-env=NOWPLAYING_DYLIB={}", dylib.display());
    }
    tauri_build::build();
}
