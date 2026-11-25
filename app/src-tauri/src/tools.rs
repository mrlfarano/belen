use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::provider;

/// Everything the broker allows lives in this one list. Edits, writes, shell
/// and general network access are NOT here; each would be a separately
/// authorized capability class (see app/src/providers/tools.ts for the plan).
const ALLOWED_TOOLS: [&str; 3] = ["workspace_list", "workspace_read", "workspace_search"];

const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LIST_ENTRIES: usize = 500;
const MAX_READ_BYTES: u64 = 65_536;
const SEARCH_DEFAULT_MATCHES: u64 = 50;
const SEARCH_MAX_MATCHES: u64 = 100;
const SEARCH_MAX_FILES: usize = 4_000;
const SEARCH_MAX_FILE_BYTES: u64 = 512 * 1024;
const SEARCH_MAX_DEPTH: usize = 12;
const SEARCH_LINE_CLIP: usize = 240;

/// Directories never searched (vendor/SCM noise, and the places credentials
/// usually hide).
const SKIP_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub call_id: String,
    pub ok: bool,
    pub content: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub denied: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

enum ToolError {
    /// Policy refusal (escape, credential, data dir). Not a failure.
    Denied(String),
    /// Operation could not be performed.
    Failed(String),
}

fn outcome(call_id: &str, content: String, truncated: bool) -> ToolOutcome {
    ToolOutcome {
        call_id: call_id.to_string(),
        ok: true,
        content,
        truncated,
        error: None,
        denied: false,
    }
}

fn denied(call_id: &str, reason: &str) -> ToolOutcome {
    ToolOutcome {
        call_id: call_id.to_string(),
        ok: true,
        content: serde_json::json!({ "error": format!("denied: {reason}") }).to_string(),
        truncated: false,
        error: None,
        denied: true,
    }
}

fn failed(call_id: &str, message: &str) -> ToolOutcome {
    ToolOutcome {
        call_id: call_id.to_string(),
        ok: false,
        content: serde_json::json!({ "error": message }).to_string(),
        truncated: false,
        error: Some(message.to_string()),
        denied: false,
    }
}

/// Dispatches one validated tool call. Runs on a blocking thread; the caller
/// enforces the time bound. Nothing here logs arguments or results.
fn dispatch(root: &str, tool: &str, call_id: &str, args_raw: &str) -> ToolOutcome {
    if !ALLOWED_TOOLS.contains(&tool) {
        return denied(call_id, "tool not allowed");
    }

    let args: serde_json::Value = match serde_json::from_str(args_raw) {
        Ok(v) => v,
        Err(_) => return failed(call_id, "arguments are not valid JSON"),
    };

    match tool {
        "workspace_list" => list(root, &args, call_id),
        "workspace_read" => read(root, &args, call_id),
        "workspace_search" => search(root, &args, call_id),
        _ => denied(call_id, "tool not allowed"),
    }
}

/// Entry point used by the `tool_exec` command: cancellation gate + time bound.
pub async fn exec(
    workspace_root: &str,
    tool: &str,
    call_id: &str,
    args_json: &str,
    stream_id: &str,
) -> ToolOutcome {
    if provider::is_cancelled(stream_id) {
        return denied(call_id, "cancelled");
    }
    exec_with_timeout(TOOL_TIMEOUT, workspace_root, tool, call_id, args_json).await
}

async fn exec_with_timeout(
    bound: Duration,
    workspace_root: &str,
    tool: &str,
    call_id: &str,
    args_json: &str,
) -> ToolOutcome {
    let root = workspace_root.to_string();
    let name = tool.to_string();
    let id = call_id.to_string();
    let raw = args_json.to_string();

    let dispatched =
        tokio::task::spawn_blocking(move || dispatch(&root, &name, &id, &raw));
    match tokio::time::timeout(bound, dispatched).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(join)) => failed(call_id, &format!("tool dispatch failed: {join}")),
        Err(_) => failed(call_id, "tool timed out"),
    }
}

// ---------------------------------------------------------------------------
// The workspace sandbox
// ---------------------------------------------------------------------------

/// Resolves a model-supplied relative path against the workspace root.
///
/// Canonicalization resolves symlinks AND Windows junctions, so a link that
/// lands outside the canonical root is rejected. Credential-like names and the
/// BELEN data directory (DPAPI key store, config, database) are denied before
/// anything is read.
fn resolve_in_workspace(root_str: &str, rel: &str) -> Result<PathBuf, ToolError> {
    if rel.is_empty() {
        return Err(ToolError::Failed("empty path".into()));
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(ToolError::Denied("absolute paths are denied".into()));
    }
    for component in rel_path.components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => {
                return Err(ToolError::Denied(
                    "path escapes the workspace".into(),
                ))
            }
        }
    }

    let root = std::fs::canonicalize(root_str)
        .map_err(|_| ToolError::Failed("workspace root is unavailable".into()))?;
    if !root.is_dir() {
        return Err(ToolError::Failed("workspace root is not a folder".into()));
    }

    let target = root.join(rel_path);
    let canonical = std::fs::canonicalize(&target)
        .map_err(|_| ToolError::Failed(format!("not found: {rel}")))?;

    if !canonical.starts_with(&root) {
        return Err(ToolError::Denied("path escapes the workspace".into()));
    }
    if is_belen_data(&canonical) {
        return Err(ToolError::Denied(
            "BELEN data directory is denied".into(),
        ));
    }
    if is_credential_path(&canonical) || is_credential_path(rel_path) {
        return Err(ToolError::Denied("credential-like paths are denied".into()));
    }
    Ok(canonical)
}

fn root_canonical(root_str: &str) -> Result<PathBuf, ToolError> {
    let root = std::fs::canonicalize(root_str)
        .map_err(|_| ToolError::Failed("workspace root is unavailable".into()))?;
    if !root.is_dir() {
        return Err(ToolError::Failed("workspace root is not a folder".into()));
    }
    Ok(root)
}

/// The app's own data directory (DPAPI keys, config.json, belen.db, exports)
/// is never readable through tools, even when the workspace contains it.
fn is_belen_data(path: &Path) -> bool {
    match crate::keys::data_root() {
        Ok(root) => match std::fs::canonicalize(&root) {
            Ok(canonical) => path.starts_with(canonical),
            Err(_) => path.starts_with(&root),
        },
        Err(_) => false,
    }
}

/// Credential-shaped file names are denied everywhere in the workspace.
fn is_credential_path(path: &Path) -> bool {
    const EXACT: [&str; 6] = [
        ".env",
        ".git-credentials",
        ".netrc",
        ".htpasswd",
        "credentials.json",
        "secrets.json",
    ];
    const EXTENSIONS: [&str; 6] = ["pem", "key", "pfx", "p12", "kdbx", "crt"];

    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();

    if EXACT.contains(&lower.as_str()) {
        return true;
    }
    if lower.starts_with(".env.") {
        return true;
    }
    if lower.starts_with("id_rsa")
        || lower.starts_with("id_dsa")
        || lower.starts_with("id_ecdsa")
        || lower.starts_with("id_ed25519")
    {
        return true;
    }
    if lower.ends_with("-private.pem") || lower.ends_with("_private.pem") {
        return true;
    }
    EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// workspace_list
// ---------------------------------------------------------------------------

fn list(root_str: &str, args: &serde_json::Value, call_id: &str) -> ToolOutcome {
    let root = match root_canonical(root_str) {
        Ok(r) => r,
        Err(e) => return tool_error(call_id, e),
    };

    let target = match args["path"].as_str() {
        Some(rel) => match resolve_in_workspace(root_str, rel) {
            Ok(p) => p,
            Err(e) => return tool_error(call_id, e),
        },
        None => root.clone(),
    };
    if !target.is_dir() {
        return failed(call_id, "path is not a folder");
    }

    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    let read = match std::fs::read_dir(&target) {
        Ok(r) => r,
        Err(e) => return failed(call_id, &format!("cannot list: {e}")),
    };
    for entry in read.flatten() {
        let path = entry.path();
        if is_credential_path(&path) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = path.is_dir();
        let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        entries.push((is_dir, name, size));
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let truncated = entries.len() > MAX_LIST_ENTRIES;
    if truncated {
        entries.truncate(MAX_LIST_ENTRIES);
    }

    let listed: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|(is_dir, name, size)| {
            serde_json::json!({
                "name": name,
                "type": if is_dir { "dir" } else { "file" },
                "size": size,
            })
        })
        .collect();

    outcome(
        call_id,
        serde_json::json!({
            "path": relative_display(&root, &target),
            "entries": listed,
            "truncated": truncated,
        })
        .to_string(),
        truncated,
    )
}

// ---------------------------------------------------------------------------
// workspace_read
// ---------------------------------------------------------------------------

fn read(root_str: &str, args: &serde_json::Value, call_id: &str) -> ToolOutcome {
    if let Err(e) = root_canonical(root_str) {
        return tool_error(call_id, e);
    }
    let Some(rel) = args["path"].as_str() else {
        return failed(call_id, "missing required argument: path");
    };
    let canonical = match resolve_in_workspace(root_str, rel) {
        Ok(p) => p,
        Err(e) => return tool_error(call_id, e),
    };
    if !canonical.is_file() {
        return failed(call_id, "path is not a file");
    }

    let max_bytes = args["maxBytes"].as_u64().unwrap_or(MAX_READ_BYTES).clamp(1, MAX_READ_BYTES);
    let mut file = match std::fs::File::open(&canonical) {
        Ok(f) => f,
        Err(e) => return failed(call_id, &format!("cannot open: {e}")),
    };
    let mut limited = file.take(max_bytes + 1);
    let mut bytes = Vec::new();
    if let Err(e) = limited.read_to_end(&mut bytes) {
        return failed(call_id, &format!("cannot read: {e}"));
    }
    let truncated = bytes.len() as u64 > max_bytes;
    if truncated {
        bytes.truncate(max_bytes as usize);
    }
    if bytes.contains(&0) {
        return failed(call_id, "binary file");
    }

    let content = String::from_utf8_lossy(&bytes);
    outcome(
        call_id,
        serde_json::json!({
            "path": rel,
            "bytes": content.len(),
            "truncated": truncated,
            "content": content,
        })
        .to_string(),
        truncated,
    )
}

// ---------------------------------------------------------------------------
// workspace_search
// ---------------------------------------------------------------------------

fn search(root_str: &str, args: &serde_json::Value, call_id: &str) -> ToolOutcome {
    let root = match root_canonical(root_str) {
        Ok(r) => r,
        Err(e) => return tool_error(call_id, e),
    };
    let Some(query) = args["query"].as_str() else {
        return failed(call_id, "missing required argument: query");
    };
    if query.trim().is_empty() {
        return failed(call_id, "query is empty");
    }
    let scope = match args["path"].as_str() {
        Some(rel) => match resolve_in_workspace(root_str, rel) {
            Ok(p) => p,
            Err(e) => return tool_error(call_id, e),
        },
        None => root.clone(),
    };
    let max_matches =
        args["maxMatches"].as_u64().unwrap_or(SEARCH_DEFAULT_MATCHES).min(SEARCH_MAX_MATCHES)
            as usize;

    let needle = query.to_lowercase();
    let mut state = SearchState {
        needle: &needle,
        root: &root,
        max_matches,
        matches: Vec::new(),
        files_visited: 0,
        truncated: false,
    };
    walk_search(&scope, 0, &mut state);

    let files_scanned = state.files_visited;
    let truncated = state.truncated;
    outcome(
        call_id,
        serde_json::json!({
            "query": query,
            "matches": state.matches,
            "filesScanned": files_scanned,
            "truncated": truncated,
        })
        .to_string(),
        truncated,
    )
}

struct SearchState<'a> {
    needle: &'a str,
    root: &'a Path,
    max_matches: usize,
    matches: Vec<serde_json::Value>,
    files_visited: usize,
    truncated: bool,
}

fn walk_search(dir: &Path, depth: usize, state: &mut SearchState) {
    if depth > SEARCH_MAX_DEPTH
        || state.files_visited >= SEARCH_MAX_FILES
        || state.matches.len() >= state.max_matches
        || state.truncated
    {
        if state.matches.len() >= state.max_matches {
            state.truncated = true;
        }
        return;
    }

    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut entries: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
    entries.sort();

    for path in entries {
        if state.files_visited >= SEARCH_MAX_FILES {
            state.truncated = true;
            return;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            let lower = name.to_ascii_lowercase();
            if SKIP_DIRS.contains(&lower.as_str()) || name.starts_with('.') {
                continue;
            }
            walk_search(&path, depth + 1, state);
        } else {
            state.files_visited += 1;
            if is_credential_path(&path) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.len() > SEARCH_MAX_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.contains(&0) {
                continue; // binary
            }
            let text = String::from_utf8_lossy(&bytes);
            let rel = relative_display(state.root, &path);
            for (line_no, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(state.needle) {
                    if state.matches.len() >= state.max_matches {
                        state.truncated = true;
                        return;
                    }
                    state.matches.push(serde_json::json!({
                        "path": rel,
                        "line": line_no + 1,
                        "text": clip_chars(line.trim_end(), SEARCH_LINE_CLIP),
                    }));
                }
            }
        }
    }
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn tool_error(call_id: &str, error: ToolError) -> ToolOutcome {
    match error {
        ToolError::Denied(reason) => denied(call_id, &reason),
        ToolError::Failed(message) => failed(call_id, &message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("belen-tools-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create workspace");
        dir
    }

    fn canonical_str(path: &Path) -> String {
        std::fs::canonicalize(path)
            .expect("canonicalize")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn unknown_tool_is_denied() {
        let out = dispatch("/tmp", "write_file", "c1", "{}");
        assert!(out.denied, "write_file must be denied");
        assert!(!out.content.contains("ok"), "denial carries no execution result");

        let out = dispatch("/tmp", "run_shell", "c2", "{}");
        assert!(out.denied);
    }

    #[test]
    fn traversal_and_absolute_paths_are_denied() {
        let ws = temp_workspace("escape");
        let root = canonical_str(&ws);
        fs::write(ws.join("readable.txt"), "hello").unwrap();
        fs::write(std::env::temp_dir().join("belen-outside.txt"), "secret").unwrap();

        for path in ["../belen-outside.txt", "sub/../../belen-outside.txt"] {
            let out = dispatch(&root, "workspace_read", "c", &format!("{{\"path\":\"{path}\"}}"));
            assert!(out.denied, "expected denial for {path}");
            assert!(out.error.is_none());
        }

        let abs = std::env::temp_dir().join("belen-outside.txt");
        let out = dispatch(
            &root,
            "workspace_read",
            "c",
            &format!("{{\"path\":\"{}\"}}", abs.display()),
        );
        assert!(out.denied, "absolute path must be denied");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn credential_paths_are_denied_even_inside_the_workspace() {
        let ws = temp_workspace("creds");
        let root = canonical_str(&ws);
        fs::write(ws.join(".env"), "API_KEY=secret").unwrap();
        fs::write(ws.join("server.key"), "-----BEGIN").unwrap();
        fs::write(ws.join("app.pem"), "-----BEGIN").unwrap();
        fs::create_dir_all(ws.join("config")).unwrap();
        fs::write(ws.join("config").join("id_rsa_backup"), "private").unwrap();

        for path in [".env", "server.key", "app.pem", "config/id_rsa_backup"] {
            let out = dispatch(&root, "workspace_read", "c", &format!("{{\"path\":\"{path}\"}}"));
            assert!(out.denied, "expected credential denial for {path}");
            assert!(!out.content.contains("secret"), "content must not leak");
        }

        // Search must not surface matches from credential files either.
        fs::write(ws.join("note.txt"), "the API_KEY=secret is referenced").unwrap();
        let out = dispatch(&root, "workspace_search", "c", "{\"query\":\"secret\"}");
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        let paths: Vec<&str> = value["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap())
            .collect();
        assert!(!paths.iter().any(|p| p.contains(".env")), ".env must be skipped");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn belen_data_directory_is_denied() {
        let data = std::env::temp_dir().join(format!("belen-tools-data-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        unsafe { std::env::set_var("BELEN_DATA_DIR", &data) };
        let ws = data.join("work");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("a.txt"), "x").unwrap();
        let root = canonical_str(&ws);

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"a.txt\"}");
        assert!(out.denied, "BELEN data dir must be denied");
        assert!(out.content.contains("data directory"));

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"../config.json\"}");
        assert!(out.denied);

        let _ = fs::remove_dir_all(&data);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_denied() {
        let ws = temp_workspace("symlink");
        let outside = temp_workspace("symlink-outside");
        fs::write(outside.join("secret.txt"), "top secret").unwrap();

        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(&outside, ws.join("link")).is_err() {
                return; // environment without symlink privileges: skip
            }
        }

        let root = canonical_str(&ws);
        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"link/secret.txt\"}");
        assert!(out.denied, "symlink escape must be denied");

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn symlink_escape_is_denied() {
        let ws = temp_workspace("symlink");
        let outside = temp_workspace("symlink-outside");
        fs::write(outside.join("secret.txt"), "top secret").unwrap();

        // Developer Mode required; skip silently when unavailable.
        if std::os::windows::fs::symlink_dir(&outside, ws.join("link")).is_err() {
            let _ = fs::remove_dir_all(&ws);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        let root = canonical_str(&ws);
        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"link/secret.txt\"}");
        assert!(out.denied, "symlink escape must be denied");

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn read_bounds_and_truncates() {
        let ws = temp_workspace("read");
        let root = canonical_str(&ws);
        let big = "x".repeat(200_000);
        fs::write(ws.join("big.txt"), &big).unwrap();

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"big.txt\"}");
        assert!(out.ok && !out.denied);
        assert!(out.truncated, "default 64KB cap must truncate");
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert!(value["content"].as_str().unwrap().chars().count() <= 65_536);

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"big.txt\",\"maxBytes\":100}");
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(value["bytes"].as_u64(), Some(100));

        // Malformed / oversized maxBytes clamps instead of failing.
        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"big.txt\",\"maxBytes\":999999}");
        assert!(out.ok);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn binary_files_are_refused() {
        let ws = temp_workspace("binary");
        let root = canonical_str(&ws);
        fs::write(ws.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"blob.bin\"}");
        assert!(!out.ok);
        assert!(out.error.unwrap().contains("binary"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn search_finds_and_caps_matches() {
        let ws = temp_workspace("search");
        let root = canonical_str(&ws);
        fs::create_dir_all(ws.join("src")).unwrap();
        for i in 0..60 {
            fs::write(ws.join(format!("f{i}.txt")), "needle here\nother\n").unwrap();
        }
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::write(ws.join("node_modules").join("n.txt"), "needle ignored\n").unwrap();

        let out = dispatch(&root, "workspace_search", "c", "{\"query\":\"NEEDLE\"}");
        assert!(out.ok);
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        let matches = value["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 50, "default cap");
        assert_eq!(matches[0]["line"], 1);
        assert_eq!(matches[0]["path"].as_str().unwrap().contains('\\') || matches[0]["path"].as_str().unwrap().contains('/'), true);

        let out = dispatch(&root, "workspace_search", "c", "{\"query\":\"needle\",\"maxMatches\":120}");
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(value["matches"].as_array().unwrap().len(), 100, "hard cap");
        assert!(value["truncated"].as_bool().unwrap());

        let paths: Vec<String> = value["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap().to_string())
            .collect();
        assert!(!paths.iter().any(|p| p.contains("node_modules")), "vendor dirs skipped");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn malformed_and_missing_arguments_error_cleanly() {
        let ws = temp_workspace("args");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "content").unwrap();

        let out = dispatch(&root, "workspace_read", "c", "not-json");
        assert!(!out.ok);
        assert!(out.error.unwrap().contains("JSON"));

        let out = dispatch(&root, "workspace_read", "c", "{}");
        assert!(!out.ok, "missing path must fail, not read the root");
        assert!(out.error.unwrap().contains("path"));

        let out = dispatch(&root, "workspace_search", "c", "{}");
        assert!(!out.ok);
        assert!(out.error.unwrap().contains("query"));

        let out = dispatch(&root, "workspace_read", "c", "{\"path\":\"missing.txt\"}");
        assert!(!out.ok);
        assert!(out.error.unwrap().contains("not found"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn list_reports_sorted_entries_and_skips_credentials() {
        let ws = temp_workspace("list");
        let root = canonical_str(&ws);
        fs::create_dir_all(ws.join("sub")).unwrap();
        fs::write(ws.join("z.txt"), "12345").unwrap();
        fs::write(ws.join("a.txt"), "1").unwrap();
        fs::write(ws.join(".env"), "no").unwrap();

        let out = dispatch(&root, "workspace_list", "c", "{}");
        assert!(out.ok);
        let value: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        let entries = value["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3, ".env must not be listed");
        assert_eq!(entries[0]["type"], "dir", "dirs first");
        assert_eq!(entries[0]["name"], "sub");
        assert_eq!(entries[1]["name"], "a.txt");
        assert_eq!(entries[2]["size"], 5);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn timeout_bounds_the_dispatch() {
        let ws = temp_workspace("timeout");
        let root = canonical_str(&ws);
        for i in 0..2000 {
            let sub = ws.join(format!("d{}", i % 20));
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join(format!("f{i}.txt")), "needle\n").unwrap();
        }

        let out = exec_with_timeout(
            Duration::from_nanos(1),
            &root,
            "workspace_search",
            "c",
            "{\"query\":\"needle\"}",
        )
        .await;
        assert!(!out.ok, "expected timeout");
        assert!(out.error.unwrap().contains("timed out"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn cancelled_stream_denies_dispatch() {
        let ws = temp_workspace("cancel");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "content").unwrap();

        provider::register_stream("test-stream");
        let out = exec(&root, "workspace_read", "c", "{\"path\":\"a.txt\"}", "test-stream").await;
        assert!(out.ok, "registered stream may dispatch");

        provider::cancel_stream("test-stream");
        let out = exec(&root, "workspace_read", "c2", "{\"path\":\"a.txt\"}", "test-stream").await;
        assert!(out.denied, "cancelled stream must be denied");
        assert!(out.content.contains("cancelled"));
        let _ = fs::remove_dir_all(&ws);
    }
}
