fn main() {
    // Tauri embeds the frontend at compile time; without this, a `dist/` change
    // alone does not invalidate the crate and the binary keeps stale assets.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
