use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::GetCurrentProcess;

static START: OnceLock<Instant> = OnceLock::new();
static BOOT_MS: OnceLock<f64> = OnceLock::new();
static SETUP_MS: OnceLock<f64> = OnceLock::new();

pub fn mark_start() {
    let _ = START.set(Instant::now());
}

pub fn since_start_ms() -> f64 {
    START
        .get()
        .map(|s| s.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Called by the renderer the moment JS boots — this is the startup number.
pub fn mark_boot() {
    let _ = BOOT_MS.set(since_start_ms());
}

/// Called from Tauri's setup hook, i.e. when the webview has been created.
pub fn mark_setup() {
    let _ = SETUP_MS.set(since_start_ms());
}

pub fn working_set_bytes() -> u64 {
    unsafe {
        let mut pmc = PROCESS_MEMORY_COUNTERS::default();
        let ok = GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut pmc,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        );
        if ok.is_ok() {
            pmc.WorkingSetSize as u64
        } else {
            0
        }
    }
}

pub fn exe_bytes() -> u64 {
    std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0)
}

pub fn snapshot() -> serde_json::Value {
    serde_json::json!({
        "bootMs": round(*BOOT_MS.get().unwrap_or(&0.0)),
        "setupMs": round(*SETUP_MS.get().unwrap_or(&0.0)),
        "processUptimeMs": round(since_start_ms()),
        "workingSetBytes": working_set_bytes(),
        "exeBytes": exe_bytes(),
        "collectedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    })
}

fn round(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}
