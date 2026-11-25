//! Portable self-update: check the release feed, verify, swap the exe, restart.
//!
//! BELEN ships as a single portable `BELEN.exe` with `data/` beside it, so an
//! update is a signed file swap, not an installer run. The feed is
//! `latest.json` on the GitHub release, signed with Ed25519; the public key is
//! compiled into this binary. Nothing checks or downloads unless the user asks
//! from the About tab — no unprompted network traffic.
//!
//! Restarting safely with the single-instance plugin: the old process spawns
//! the new exe with `--wait-pid=<pid>` and exits; the new process waits for
//! that PID before building the Tauri app, so the newcomer is never seen as a
//! duplicate instance.

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use ring::digest::Context;
use ring::signature::{UnparsedPublicKey, ED25519};
use semver::Version;
use serde::{Deserialize, Serialize};

/// Stable asset URL of the newest release. `BELEN_UPDATE_FEED` overrides it so
/// a local rehearsal can serve the manifest from loopback (http is allowed
/// there; every other host must be https).
pub const DEFAULT_FEED: &str =
    "https://github.com/mrlfarano/belen/releases/latest/download/latest.json";
pub const RELEASE_PAGE: &str = "https://github.com/mrlfarano/belen/releases/latest";

/// First line of every signed message; bump when the manifest format changes.
const SIGNING_PREFIX: &str = "BELEN-UPDATE-1";

/// Raw Ed25519 public key, 64 hex chars, written by `pnpm release init`.
/// `trim` at the use site — `str::trim` is not callable in const context.
const PUBLIC_KEY_HEX: &str = include_str!("../update.pubkey");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: Option<String>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub current: String,
    pub available: Option<UpdateInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProgress {
    pub received: u64,
    pub total: Option<u64>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

fn feed_url() -> String {
    std::env::var("BELEN_UPDATE_FEED").unwrap_or_else(|_| DEFAULT_FEED.to_string())
}

fn signed_message(version: &str, sha256: &str) -> Vec<u8> {
    format!("{SIGNING_PREFIX}\n{version}\n{sha256}").into_bytes()
}

fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    let text = input.trim();
    if text.len() % 2 != 0 {
        return Err("hex input has an odd length".to_string());
    }
    (0..text.len() / 2)
        .map(|i| {
            u8::from_str_radix(&text[2 * i..2 * i + 2], 16)
                .map_err(|e| format!("invalid hex at byte {i}: {e}"))
        })
        .collect()
}

fn verify_signature(key_hex: &str, message: &[u8], signature_hex: &str) -> Result<(), String> {
    let key = decode_hex(key_hex)?;
    if key.len() != 32 {
        return Err(format!("public key must be 32 bytes, got {}", key.len()));
    }
    let signature = decode_hex(signature_hex)?;
    if signature.len() != 64 {
        return Err(format!("signature must be 64 bytes, got {}", signature.len()));
    }
    let verifier = UnparsedPublicKey::new(&ED25519, key);
    verifier
        .verify(message, &signature)
        .map_err(|_| "signature does not match this manifest (or this app's key)".to_string())
}

/// The signature covers exactly `BELEN-UPDATE-1`, the version and the hash —
/// never the URL or notes, which are advisory.
pub fn verify_manifest(manifest: &Manifest) -> Result<(), String> {
    let message = signed_message(&manifest.version, &manifest.sha256);
    verify_signature(PUBLIC_KEY_HEX.trim(), &message, &manifest.signature)
}

fn parse_version(text: &str) -> Result<Version, String> {
    let cleaned = text.trim().trim_start_matches('v');
    Version::parse(cleaned).map_err(|e| format!("invalid version {cleaned:?}: {e}"))
}

fn is_newer(candidate: &str, current: &str) -> Result<bool, String> {
    Ok(parse_version(candidate)? > parse_version(current)?)
}

/// Updates are release-build only: `tauri dev` binaries would otherwise try to
/// overwrite the source tree's target exe.
fn ensure_updatable() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "updates are disabled in debug builds — build with scripts/build.ps1 -TauriBuild first"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid update URL {raw:?}: {e}"))?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost" || host == "[::1]" || host.starts_with("127.0.0.");
    if url.scheme() != "https" && !loopback {
        return Err(format!("update URL must be https, got {raw:?}"));
    }
    Ok(url)
}

async fn fetch_manifest() -> Result<Manifest, String> {
    let url = feed_url();
    let response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not reach the update feed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "no update manifest at {url} (HTTP {}) — publish one with \"pnpm release publish\", or download from {RELEASE_PAGE}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("could not read the update manifest: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("update manifest is not valid JSON: {e}"))
}

pub async fn check() -> Result<CheckResult, String> {
    let manifest = fetch_manifest().await?;
    verify_manifest(&manifest)?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let available = if is_newer(&manifest.version, &current)? {
        Some(UpdateInfo {
            version: manifest.version,
            notes: manifest.notes,
            url: manifest.url,
        })
    } else {
        None
    };
    Ok(CheckResult { current, available })
}

/// Download, hash-verify and swap the exe. The URL always comes from the
/// re-fetched, re-verified manifest — never from the webview.
pub async fn apply(
    on_progress: &mut (dyn FnMut(ApplyProgress) + Send),
) -> Result<UpdateInfo, String> {
    ensure_updatable()?;

    let manifest = fetch_manifest().await?;
    verify_manifest(&manifest)?;

    let current = parse_version(env!("CARGO_PKG_VERSION"))?;
    let latest = parse_version(&manifest.version)?;
    if latest <= current {
        return Err(format!(
            "the feed's version ({}) is not newer than the running one ({current})",
            manifest.version
        ));
    }

    let url = validate_url(&manifest.url)?;
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the executable: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("executable has no parent directory")?
        .to_path_buf();
    let new_path = dir.join("BELEN.exe.new");
    let old_path = dir.join("BELEN.exe.old");

    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed: HTTP {} from {}",
            response.status(),
            manifest.url
        ));
    }

    let total = response.content_length();
    let mut file = File::create(&new_path)
        .map_err(|e| format!("cannot write beside the executable ({dir:?}): {e}"))?;
    let mut hasher = Context::new(&ring::digest::SHA256);
    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = fs::remove_file(&new_path);
            format!("download interrupted: {e}")
        })?;
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk) {
            let _ = fs::remove_file(&new_path);
            return Err(format!("cannot write the downloaded exe: {e}"));
        }
        received += chunk.len() as u64;
        on_progress(ApplyProgress {
            received,
            total,
        });
    }
    if let Err(e) = file.flush() {
        let _ = fs::remove_file(&new_path);
        return Err(format!("cannot flush the downloaded exe: {e}"));
    }
    drop(file);

    let sha256 = hex_lower(&hasher.finish().as_ref());
    if !sha256.eq_ignore_ascii_case(&manifest.sha256) {
        let _ = fs::remove_file(&new_path);
        return Err(format!(
            "the downloaded exe failed verification (sha256 {sha256}, expected {}) — update refused, nothing was changed",
            manifest.sha256
        ));
    }

    swap(&exe, &new_path, &old_path)?;
    Ok(UpdateInfo {
        version: manifest.version,
        notes: manifest.notes,
        url: manifest.url,
    })
}

/// Rename-based swap: a running exe cannot be deleted on Windows, but it can
/// be renamed — so move the old image aside, slide the new one in, and roll
/// back if the second rename fails.
fn swap(exe: &Path, new_path: &Path, old_path: &Path) -> Result<(), String> {
    let _ = fs::remove_file(old_path);
    fs::rename(exe, old_path).map_err(|e| format!("could not move the running exe aside: {e}"))?;
    if let Err(e) = fs::rename(new_path, exe) {
        let _ = fs::rename(old_path, exe);
        return Err(format!("could not move the new exe into place (rolled back): {e}"));
    }
    Ok(())
}

/// Record what the next launch should report. The marker doubles as the user's
/// visible confirmation that the whole update loop worked.
fn write_applied_note(version: &str) {
    if let Ok(root) = crate::keys::data_root() {
        let note = serde_json::json!({ "version": version, "appliedAt": now_millis() });
        let _ = fs::write(root.join("update.json"), note.to_string());
    }
}

/// Consume the applied-update marker, if one is pending.
pub fn take_applied_note() -> Option<String> {
    let root = crate::keys::data_root().ok()?;
    let path = root.join("update.json");
    let text = fs::read_to_string(path).ok()?;
    let _ = fs::remove_file(root.join("update.json"));
    let note: serde_json::Value = serde_json::from_str(&text).ok()?;
    note.get("version").and_then(|v| v.as_str()).map(String::from)
}

/// Called before anything else on every launch: clear a previous update's
/// leftovers, and if this launch is the handoff (`--wait-pid=`), wait for the
/// old process to exit so the single-instance plugin never sees both of us.
pub fn handle_startup_args() {
    cleanup_leftovers();
    if let Some(pid) = std::env::args()
        .find_map(|a| a.strip_prefix("--wait-pid=").map(String::from))
        .and_then(|v| v.parse::<u32>().ok())
    {
        wait_for_process_exit(pid);
    }
}

fn cleanup_leftovers() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if let Some(dir) = exe.parent() {
        let _ = fs::remove_file(dir.join("BELEN.exe.old"));
        let _ = fs::remove_file(dir.join("BELEN.exe.new"));
    }
}

/// Spawn the freshly installed exe and let the caller exit; the child waits
/// for `after_pid` before coming up.
pub fn relaunch(after_pid: u32) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate the executable: {e}"))?;
    std::process::Command::new(&exe)
        .arg(format!("--wait-pid={after_pid}"))
        .spawn()
        .map_err(|e| format!("could not start the new version: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn wait_for_process_exit(pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, WAIT_EVENT,
    };

    const HANDOFF_TIMEOUT_MS: u32 = 30_000;

    unsafe {
        // If the old process is already gone, OpenProcess fails and we are done.
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return;
        };
        let waited = WaitForSingleObject(handle, HANDOFF_TIMEOUT_MS);
        let _ = CloseHandle(handle);
        if waited == WAIT_EVENT(WAIT_OBJECT_0) {
            return;
        }
        // Timed out: the old instance is hung. Proceed anyway — the
        // single-instance plugin will send the newcomer home rather than let
        // two windows fight.
    }
}

#[cfg(not(windows))]
fn wait_for_process_exit(_pid: u32) {
    // Windows is the only supported desktop target; other platforms are
    // compiled for tests only, where there is no handoff to wait for.
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway Ed25519 identity generated with Node (the same code path as
    // `pnpm release sign`), proving the Node-signed format verifies here.
    const TEST_KEY_HEX: &str = "50c1c9edc6c3ffe34ce3525d86a8f74d89990b9f2edb9fd8b6708771c63997f9";
    const TEST_SIG_HEX: &str = "b80a28a77bf57735ba6e2a3649c413c09688a305617adb6c7cfbe43589386ca73a06bfd6d23122d8a40a148d026483908dd4b28b298c5521507d7a10bbd36800";

    fn test_message(version: &str) -> Vec<u8> {
        // The payload the Node vector was signed over: prefix, version, hash.
        signed_message(version, &"ab".repeat(32))
    }

    #[test]
    fn node_signed_vector_verifies() {
        verify_signature(TEST_KEY_HEX, &test_message("0.2.0"), TEST_SIG_HEX).expect("valid vector");
    }

    #[test]
    fn tampered_message_is_rejected() {
        let tampered = test_message("0.2.1");
        assert!(verify_signature(TEST_KEY_HEX, &tampered, TEST_SIG_HEX).is_err());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let other = "26aa645b14e8bc52babbded398056c61d8120a3095f79ec04452abad2f587fb1";
        assert!(verify_signature(other, &test_message("0.2.0"), TEST_SIG_HEX).is_err());
    }

    #[test]
    fn truncated_signature_is_rejected() {
        assert!(verify_signature(TEST_KEY_HEX, &test_message("0.2.0"), &TEST_SIG_HEX[..16]).is_err());
    }

    #[test]
    fn committed_key_is_well_formed() {
        let key = decode_hex(PUBLIC_KEY_HEX.trim()).expect("hex");
        assert_eq!(key.len(), 32, "committed update key must be 32 raw bytes");
    }

    #[test]
    fn signed_message_format_is_stable() {
        assert_eq!(
            signed_message("0.2.0", "deadbeef"),
            b"BELEN-UPDATE-1\n0.2.0\ndeadbeef".to_vec()
        );
    }

    #[test]
    fn version_comparison() {
        assert!(is_newer("0.2.0", "0.1.0").unwrap());
        assert!(is_newer("v0.2.0", "0.1.0").unwrap(), "leading v allowed");
        assert!(is_newer("0.10.0", "0.9.9").unwrap(), "numeric, not lexical");
        assert!(is_newer("0.1.1", "0.1.0").unwrap());
        assert!(!is_newer("0.1.0", "0.1.0").unwrap());
        assert!(!is_newer("0.1.0", "0.2.0").unwrap());
        assert!(is_newer("0.2.0", "0.2.0-rc.1").unwrap(), "release beats pre-release");
        assert!(!is_newer("0.2.0-rc.1", "0.2.0").unwrap());
        assert!(is_newer("0.2.0", "0.1.0").is_ok());
        assert!(is_newer("not-a-version", "0.1.0").is_err());
    }

    #[test]
    fn url_rules() {
        assert!(validate_url("https://example.com/BELEN.exe").is_ok());
        assert!(validate_url("http://127.0.0.1:8788/BELEN.exe").is_ok(), "loopback rehearsal");
        assert!(validate_url("http://localhost:9000/latest").is_ok());
        assert!(validate_url("http://example.com/BELEN.exe").is_err(), "plain http refused");
        assert!(validate_url("ftp://example.com/BELEN.exe").is_err());
        assert!(validate_url("not a url").is_err());
    }

    #[test]
    fn decode_hex_roundtrip() {
        assert_eq!(decode_hex("00ff10").unwrap(), vec![0x00, 0xff, 0x10]);
        assert!(decode_hex("abc").is_err());
        assert!(decode_hex("zz").is_err());
    }

    #[test]
    fn swap_replaces_the_exe() {
        let dir = std::env::temp_dir().join("belen-swap-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("BELEN.exe");
        let new_path = dir.join("BELEN.exe.new");
        let old_path = dir.join("BELEN.exe.old");
        fs::write(&exe, b"old").unwrap();
        fs::write(&new_path, b"new").unwrap();

        swap(&exe, &new_path, &old_path).expect("swap");

        assert_eq!(fs::read(&exe).unwrap(), b"new");
        assert_eq!(fs::read(&old_path).unwrap(), b"old");
        assert!(!new_path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn swap_rolls_back_when_the_new_exe_cannot_move() {
        let dir = std::env::temp_dir().join("belen-swap-rollback-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("BELEN.exe");
        let old_path = dir.join("BELEN.exe.old");
        fs::write(&exe, b"old").unwrap();

        let missing = dir.join("BELEN.exe.missing");
        let error = swap(&exe, &missing, &old_path).expect_err("second rename fails");
        assert!(error.contains("rolled back"), "unexpected message: {error}");
        assert_eq!(fs::read(&exe).unwrap(), b"old", "original exe restored");
        assert!(!old_path.exists(), "old image moved back");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn updates_are_refused_in_debug_builds() {
        // In `cargo test` debug_assertions is on, so this must refuse; in a
        // release test build the branch is compiled out and the check passes.
        let result = ensure_updatable();
        if cfg!(debug_assertions) {
            assert!(result.is_err());
        } else {
            assert!(result.is_ok());
        }
    }

    #[test]
    fn applied_note_roundtrip() {
        let dir = std::env::temp_dir().join("belen-update-note-test");
        let _ = fs::remove_dir_all(&dir);
        unsafe { std::env::set_var("BELEN_DATA_DIR", &dir) };

        assert!(take_applied_note().is_none());
        write_applied_note("0.2.0");
        assert_eq!(take_applied_note(), Some("0.2.0".to_string()));
        assert!(take_applied_note().is_none(), "marker consumed once");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_args_parse_wait_pid() {
        // handle_startup_args itself would block on a live pid; assert the
        // parsing shape it relies on instead.
        let args = vec!["BELEN.exe".to_string(), "--wait-pid=4242".to_string()];
        let parsed = args
            .iter()
            .find_map(|a| a.strip_prefix("--wait-pid=").map(String::from))
            .and_then(|v| v.parse::<u32>().ok());
        assert_eq!(parsed, Some(4242));
    }
}
