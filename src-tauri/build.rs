// Compiles the Now Playing bridge dylib (bridge/nowplaying.m) during the build
// and places it next to the app, so the Rust side can spawn perl against it.
// The linker ad-hoc-signs it, which is all MediaRemote's platform-binary gate
// needs from the *loaded* code — the trust comes from perl, the host.
use std::path::Path;
use std::process::Command;

fn main() {
    if cfg!(target_os = "macos") {
        let out = std::env::var("OUT_DIR").unwrap();
        let dylib = Path::new(&out).join("libnowplaying.dylib");
        println!("cargo:rerun-if-changed=bridge/nowplaying.m");
        let status = Command::new("clang")
            .args([
                "-dynamiclib",
                "-fobjc-arc",
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
