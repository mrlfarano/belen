use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::provider;
use crate::shell;
use crate::web;

/// The one class that needs no switch: looking never changed anything.
const READ_TOOLS: [&str; 3] = ["workspace_list", "workspace_read", "workspace_search"];

/// Every tool the broker knows how to run. Which of them a call may use is
/// decided per call by `Policy` (Settings → Chat → Tools): workspace reads
/// are always available, every other class stays off until the user switches
/// it on. A name missing here is refused no matter what is switched on.
const ALLOWED_TOOLS: [&str; 8] = [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "web_search",
    "web_fetch",
    "workspace_write",
    "workspace_edit",
    "run_command",
];

const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
/// Web tools bound themselves (and follow redirects); this is the backstop.
const WEB_TIMEOUT: Duration = Duration::from_secs(25);

/// One `workspace_write` may carry this much; `workspace_edit` works on
/// files up to the second figure.
const MAX_WRITE_BYTES: usize = 256 * 1024;
const MAX_EDIT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OLD_TEXT_CHARS: usize = 32_000;
const MAX_NEW_TEXT_CHARS: usize = 64_000;
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

/// Why a tool did not do what was asked.
#[derive(Debug)]
pub(crate) enum ToolError {
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

/// Which calls stop for the user's approval in the room before they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// Commands and file changes.
    Changes,
    /// Commands only; file changes apply on their own.
    Commands,
    /// Nothing waits — the user chose this.
    Never,
}

/// The tool switches as the user set them in Settings → Chat → Tools. This is
/// the trust boundary: the webview decides which tools to advertise, but the
/// broker reads the switches itself for every call, so flipping one off takes
/// effect on the next call and nothing depends on the webview's good behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub network: bool,
    pub files_write: bool,
    pub shell: bool,
    pub ask: Ask,
}

impl Default for Policy {
    /// Absent settings mean every switch is off and the strictest approval.
    fn default() -> Self {
        Policy {
            network: false,
            files_write: false,
            shell: false,
            ask: Ask::Changes,
        }
    }
}

impl Policy {
    /// From the `tools` section of config.json. A value that is not exactly
    /// what the schema says counts as off — a hand-edited "yes", "editor" or
    /// "sometimes" never widens what the model may do.
    pub fn from_config(tools: &serde_json::Value) -> Policy {
        let ask = match tools["askBefore"].as_str() {
            Some("commands") => Ask::Commands,
            Some("never") => Ask::Never,
            _ => Ask::Changes,
        };
        Policy {
            network: tools["network"].as_bool() == Some(true),
            files_write: tools["files"].as_str() == Some("write"),
            shell: tools["shell"].as_bool() == Some(true),
            ask,
        }
    }

    /// `Err` carries the reason the model is given, so it can tell the user
    /// which switch to flip instead of guessing.
    fn allowed(&self, tool: &str) -> Result<(), String> {
        let on = |enabled: bool, what: &str| {
            if enabled {
                Ok(())
            } else {
                Err(format!("{what} (Settings → Chat → Tools)"))
            }
        };
        match tool {
            tool if READ_TOOLS.contains(&tool) => Ok(()),
            "web_search" | "web_fetch" => on(self.network, "Web tools are switched off"),
            "workspace_write" | "workspace_edit" => {
                on(self.files_write, "Changing files is switched off")
            }
            "run_command" => on(self.shell, "Running commands is switched off"),
            _ => Err("tool not allowed".into()),
        }
    }

    fn needs_approval(&self, tool: &str) -> bool {
        match (self.ask, tool) {
            (Ask::Never, _) => false,
            (_, "run_command") => true,
            (Ask::Changes, "workspace_write" | "workspace_edit") => true,
            _ => false,
        }
    }
}

/// The saved policy, read from disk. Missing or unreadable ⇒ everything off.
fn load_policy() -> Policy {
    let Ok(dir) = crate::keys::data_root() else {
        return Policy::default();
    };
    match std::fs::read_to_string(dir.join("config.json")) {
        Ok(text) => parse_policy(&text),
        Err(_) => Policy::default(),
    }
}

fn parse_policy(config_text: &str) -> Policy {
    match serde_json::from_str::<serde_json::Value>(config_text) {
        Ok(json) => Policy::from_config(&json["tools"]),
        Err(_) => Policy::default(),
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
        "workspace_write" => write(root, &args, call_id),
        "workspace_edit" => edit(root, &args, call_id),
        _ => denied(call_id, "tool not allowed"),
    }
}

/// Entry point used by the `tool_exec` command: policy gate, cancellation
/// gate, time bound.
///
/// `approved` is the webview's word that the user okayed this call in the
/// room. Rust cannot see a click, so it cannot verify that — but requiring the
/// flag means a renderer that dispatches a gated call without asking is
/// refused here instead of running.
pub async fn exec(
    workspace_root: &str,
    tool: &str,
    call_id: &str,
    args_json: &str,
    stream_id: &str,
    approved: bool,
) -> ToolOutcome {
    exec_under(
        &load_policy(),
        workspace_root,
        tool,
        call_id,
        args_json,
        stream_id,
        approved,
    )
    .await
}

async fn exec_under(
    policy: &Policy,
    workspace_root: &str,
    tool: &str,
    call_id: &str,
    args_json: &str,
    stream_id: &str,
    approved: bool,
) -> ToolOutcome {
    if let Err(reason) = policy.allowed(tool) {
        return denied(call_id, &reason);
    }
    if policy.needs_approval(tool) && !approved {
        return denied(call_id, "this call waits for the user's approval");
    }
    if provider::is_cancelled(stream_id) {
        return denied(call_id, "cancelled");
    }

    // Web tools do their own I/O on the runtime and bound themselves; they
    // never reach the blocking dispatcher.
    if web::handles(tool) {
        return match tokio::time::timeout(WEB_TIMEOUT, web::exec(tool, args_json)).await {
            Ok(Ok((content, truncated))) => outcome(call_id, content, truncated),
            Ok(Err(error)) => tool_error(call_id, error),
            Err(_) => failed(call_id, "the web tool timed out"),
        };
    }
    if shell::handles(tool) {
        let cwd = match working_dir(workspace_root, args_json) {
            Ok(cwd) => cwd,
            Err(error) => return tool_error(call_id, error),
        };
        // The runner keeps the command's own limit and kills what it started;
        // this bound only exists so a stuck runner cannot hold the call.
        let bound = shell::outer_bound(args_json);
        return match tokio::time::timeout(bound, shell::run(&cwd, args_json, stream_id)).await {
            Ok(Ok((content, truncated))) => outcome(call_id, content, truncated),
            Ok(Err(error)) => tool_error(call_id, error),
            Err(_) => failed(
                call_id,
                "the command ran past its limit and could not be stopped",
            ),
        };
    }
    exec_with_timeout(TOOL_TIMEOUT, workspace_root, tool, call_id, args_json).await
}

/// The folder a command runs in: the workspace, or one subfolder of it,
/// checked the way a read is.
fn working_dir(root_str: &str, args_raw: &str) -> Result<PathBuf, ToolError> {
    let args: serde_json::Value = serde_json::from_str(args_raw).unwrap_or_default();
    match args["cwd"].as_str() {
        None | Some("") => root_canonical(root_str),
        Some(rel) => {
            let dir = resolve_in_workspace(root_str, rel)?;
            if !dir.is_dir() {
                return Err(ToolError::Failed(format!("not a folder: {rel}")));
            }
            Ok(dir)
        }
    }
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

/// A relative path with no way up or out: not absolute, and made only of
/// normal components (no `..`, no root, no drive or share prefix).
fn check_relative(rel: &str) -> Result<(), ToolError> {
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
            _ => return Err(ToolError::Denied("path escapes the workspace".into())),
        }
    }
    Ok(())
}

/// Resolves a model-supplied relative path against the workspace root.
///
/// Canonicalization resolves symlinks AND Windows junctions, so a link that
/// lands outside the canonical root is rejected. Credential-like names and the
/// BELEN data directory (DPAPI key store, config, database) are denied before
/// anything is read.
fn resolve_in_workspace(root_str: &str, rel: &str) -> Result<PathBuf, ToolError> {
    check_relative(rel)?;

    let root = std::fs::canonicalize(root_str)
        .map_err(|_| ToolError::Failed("workspace root is unavailable".into()))?;
    if !root.is_dir() {
        return Err(ToolError::Failed("workspace root is not a folder".into()));
    }

    let rel_path = Path::new(rel);
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

// ---------------------------------------------------------------------------
// workspace_write / workspace_edit
// ---------------------------------------------------------------------------

/// Where a write lands. Unlike `resolve_in_workspace` the file need not exist
/// yet, so the guarantee is built from what does: the folder goes through the
/// same canonical check a read gets (a junction or symlink leading out is
/// caught there), and anything already at the path is followed once — a link
/// that stays inside the workspace is fine, one that leaves, or leads
/// nowhere, is not.
fn resolve_write_target(root_str: &str, rel: &str) -> Result<PathBuf, ToolError> {
    check_relative(rel)?;
    // Refused by name first, so a credential path is refused the same way
    // whether or not anything exists around it.
    if is_credential_path(Path::new(rel)) {
        return Err(ToolError::Denied(
            "credential-like paths are denied".into(),
        ));
    }
    let root = root_canonical(root_str)?;
    let rel_path = Path::new(rel);

    let parent = match rel_path.parent().and_then(|p| p.to_str()) {
        Some("") | None => root.clone(),
        Some(parent_rel) => {
            let dir = resolve_in_workspace(root_str, parent_rel)?;
            if !dir.is_dir() {
                return Err(ToolError::Failed(format!("not a folder: {parent_rel}")));
            }
            dir
        }
    };
    let name = rel_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ToolError::Failed(format!("not a file path: {rel}")))?;
    let target = parent.join(name);
    if is_belen_data(&target) {
        return Err(ToolError::Denied(
            "BELEN data directory is denied".into(),
        ));
    }

    Ok(match std::fs::symlink_metadata(&target) {
        // Nothing there yet: this creates the file.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => target,
        Err(e) => return Err(ToolError::Failed(format!("cannot look at {rel}: {e}"))),
        Ok(_) => {
            let real = std::fs::canonicalize(&target)
                .map_err(|_| ToolError::Denied("path escapes the workspace".into()))?;
            if !real.starts_with(&root) {
                return Err(ToolError::Denied("path escapes the workspace".into()));
            }
            if !real.is_file() {
                return Err(ToolError::Failed(format!("not a file: {rel}")));
            }
            real
        }
    })
}

/// Puts `content` at `path` the one way that cannot leave it half written:
/// into a neighbour first, then renamed over. A failure part-way leaves the
/// original exactly as it was and takes the neighbour with it.
fn replace_file(path: &Path, content: &str) -> std::io::Result<()> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let neighbour = path.with_file_name(format!(".{name}.{unique}.belen-tmp"));
    let result = std::fs::write(&neighbour, content).and_then(|()| std::fs::rename(&neighbour, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&neighbour);
    }
    result
}

fn write(root_str: &str, args: &serde_json::Value, call_id: &str) -> ToolOutcome {
    let (Some(rel), Some(content)) = (args["path"].as_str(), args["content"].as_str()) else {
        return failed(call_id, "missing required argument: path and content");
    };
    if content.len() > MAX_WRITE_BYTES {
        return failed(call_id, "content is over the 256 KB limit; write a smaller file");
    }
    let target = match resolve_write_target(root_str, rel) {
        Ok(path) => path,
        Err(e) => return tool_error(call_id, e),
    };
    let created = !target.exists();
    if let Err(e) = replace_file(&target, content) {
        return failed(call_id, &format!("cannot write {rel}: {e}"));
    }
    outcome(
        call_id,
        serde_json::json!({
            "path": rel,
            "created": created,
            "bytes": content.len(),
            "lines": content.lines().count(),
        })
        .to_string(),
        false,
    )
}

fn edit(root_str: &str, args: &serde_json::Value, call_id: &str) -> ToolOutcome {
    let (Some(rel), Some(old), Some(new)) = (
        args["path"].as_str(),
        args["oldText"].as_str(),
        args["newText"].as_str(),
    ) else {
        return failed(call_id, "missing required argument: path, oldText and newText");
    };
    let everywhere = args["replaceAll"].as_bool().unwrap_or(false);
    if old.is_empty() {
        return failed(call_id, "oldText is empty; there is nothing to find");
    }
    if old.chars().count() > MAX_OLD_TEXT_CHARS || new.chars().count() > MAX_NEW_TEXT_CHARS {
        return failed(call_id, "oldText or newText is too long; edit a smaller piece");
    }
    let target = match resolve_write_target(root_str, rel) {
        Ok(path) => path,
        Err(e) => return tool_error(call_id, e),
    };
    if !target.is_file() {
        return failed(call_id, &format!("not found: {rel}"));
    }
    if std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0) > MAX_EDIT_FILE_BYTES {
        return failed(call_id, "the file is over the 2 MB edit limit");
    }
    let text = match std::fs::read(&target).map(String::from_utf8) {
        Ok(Ok(text)) => text,
        Ok(Err(_)) => {
            return failed(
                call_id,
                "the file is not UTF-8 text, so it cannot be edited here",
            )
        }
        Err(e) => return failed(call_id, &format!("cannot read {rel}: {e}")),
    };

    // Exactly one match, or the model says so: an edit that lands in the
    // wrong place is worse than one that does not land.
    let found = text.matches(old).count();
    if found == 0 {
        return failed(call_id, &format!(
            "oldText was not found in {rel}; read the file and copy the text exactly, whitespace and line breaks included"
        ));
    }
    if found > 1 && !everywhere {
        return failed(call_id, &format!(
            "oldText matches {found} places in {rel}; include more of the surrounding text so it matches once, or set replaceAll"
        ));
    }
    let updated = if everywhere {
        text.replace(old, new)
    } else {
        text.replacen(old, new, 1)
    };
    if let Err(e) = replace_file(&target, &updated) {
        return failed(call_id, &format!("cannot write {rel}: {e}"));
    }
    outcome(
        call_id,
        serde_json::json!({
            "path": rel,
            "replacements": if everywhere { found } else { 1 },
            "bytesBefore": text.len(),
            "bytesAfter": updated.len(),
        })
        .to_string(),
        false,
    )
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
        // The needle files live in src/ so the reported relative paths carry a
        // separator on every platform, and 150 of them push past the 100-match
        // hard cap the second half of this test asserts.
        fs::create_dir_all(ws.join("src")).unwrap();
        for i in 0..150 {
            fs::write(ws.join("src").join(format!("f{i}.txt")), "needle here\nother\n").unwrap();
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

        // tokio returns the future's output when it completes on its first
        // poll, even if the deadline has already passed — and a warm cache
        // can finish this walk inside that window (seen once on CI). The 1 ns
        // bound only produces a timeout when the dispatch yields first, so a
        // single attempt is racy; the property under test is that an outlived
        // bound errors, which holds whenever the bound is enforced at all.
        let mut timed_out = false;
        for _ in 0..5 {
            let out = exec_with_timeout(
                Duration::from_nanos(1),
                &root,
                "workspace_search",
                "c",
                "{\"query\":\"needle\"}",
            )
            .await;
            if !out.ok && out.error.unwrap_or_default().contains("timed out") {
                timed_out = true;
                break;
            }
        }
        assert!(timed_out, "expected the 1 ns bound to produce a timeout");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn cancelled_stream_denies_dispatch() {
        let ws = temp_workspace("cancel");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "content").unwrap();

        provider::register_stream("test-stream");
        let out = exec_under(&Policy::default(), &root, "workspace_read", "c", "{\"path\":\"a.txt\"}", "test-stream", false).await;
        assert!(out.ok, "registered stream may dispatch");

        provider::cancel_stream("test-stream");
        let out = exec_under(&Policy::default(), &root, "workspace_read", "c2", "{\"path\":\"a.txt\"}", "test-stream", false).await;
        assert!(out.denied, "cancelled stream must be denied");
        assert!(out.content.contains("cancelled"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn a_tool_call_dispatched_after_its_stream_ended_normally_is_not_cancelled() {
        // The order inside the running app: the model's stream sends its last
        // events (tool calls among them) and ends; only then does the renderer
        // dispatch the call. A stream that ended on its own must not read as a
        // cancelled one, or no tool call could ever run.
        let ws = temp_workspace("ended-stream");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "content").unwrap();
        let policy = Policy::default();

        provider::register_stream("ended-on-its-own");
        provider::finish_stream("ended-on-its-own");
        let out = exec_under(&policy, &root, "workspace_read", "c", "{\"path\":\"a.txt\"}", "ended-on-its-own", false).await;
        // (A denial reports ok too: insist on the file actually having been read.)
        assert!(!out.denied, "a stream that finished is not a cancelled one: {}", out.content);
        assert!(out.content.contains("content"), "{}", out.content);

        // One the user did cancel still is — after it ended, while a command
        // or an approval from that run may still be in flight.
        provider::cancel_stream("ended-on-its-own");
        let out = exec_under(&policy, &root, "workspace_read", "c2", "{\"path\":\"a.txt\"}", "ended-on-its-own", false).await;
        assert!(out.denied && out.content.contains("cancelled"), "{}", out.content);

        // Cancelling an id never seen before is remembered the same way, and
        // does not touch any other stream.
        provider::cancel_stream("never-registered");
        assert!(provider::is_cancelled("never-registered"));
        provider::register_stream("a-later-stream");
        provider::finish_stream("a-later-stream");
        let out = exec_under(&policy, &root, "workspace_read", "c3", "{\"path\":\"a.txt\"}", "a-later-stream", false).await;
        assert!(!out.denied, "{}", out.content);
        let _ = fs::remove_dir_all(&ws);
    }

    // --- Policy: the switches the broker enforces itself -------------------

    const NEW_CLASS_TOOLS: [&str; 5] =
        ["web_search", "web_fetch", "workspace_write", "workspace_edit", "run_command"];

    #[test]
    fn every_class_is_off_until_it_is_switched_on() {
        let off = Policy::from_config(&serde_json::json!({}));
        assert_eq!(off, Policy::default(), "no settings is the default policy");

        for tool in NEW_CLASS_TOOLS {
            let reason = off.allowed(tool).err().unwrap_or_default();
            assert!(reason.contains("switched off"), "{tool} must be off by default");
        }
        for tool in READ_TOOLS {
            assert!(off.allowed(tool).is_ok(), "{tool} is always available");
        }
        assert_eq!(off.allowed("run_shell").unwrap_err(), "tool not allowed");
    }

    #[test]
    fn a_switch_enables_only_its_own_class() {
        let web = Policy::from_config(&serde_json::json!({ "network": true }));
        assert!(web.allowed("web_search").is_ok());
        assert!(web.allowed("web_fetch").is_ok());
        assert!(web.allowed("workspace_write").is_err());
        assert!(web.allowed("run_command").is_err());

        let all = Policy::from_config(
            &serde_json::json!({ "network": true, "files": "write", "shell": true }),
        );
        for tool in NEW_CLASS_TOOLS {
            assert!(all.allowed(tool).is_ok(), "{tool}");
        }
    }

    #[test]
    fn values_that_are_not_the_schema_count_as_off() {
        // "yes" is not a boolean, "editor" is not a mode, "sometimes" is not
        // a policy: a hand-edited config never widens what may run.
        let odd = Policy::from_config(&serde_json::json!({
            "network": "yes", "files": "editor", "shell": 1, "askBefore": "sometimes",
        }));
        assert_eq!(odd, Policy::default());
    }

    #[test]
    fn a_broken_config_leaves_everything_off() {
        assert_eq!(parse_policy("{ not json"), Policy::default());
        assert_eq!(parse_policy(r#"{"provider":{}}"#), Policy::default());
        assert!(parse_policy(r#"{"tools":{"shell":true}}"#).shell);
    }

    #[test]
    fn commands_and_file_changes_wait_for_approval_by_default() {
        let all = Policy::from_config(
            &serde_json::json!({ "network": true, "files": "write", "shell": true }),
        );
        for tool in ["run_command", "workspace_write", "workspace_edit"] {
            assert!(all.needs_approval(tool), "{tool} must ask");
        }
        for tool in [
            "web_search",
            "web_fetch",
            "workspace_list",
            "workspace_read",
            "workspace_search",
        ] {
            assert!(!all.needs_approval(tool), "{tool} runs on its own");
        }

        let commands_only = Policy::from_config(&serde_json::json!({ "askBefore": "commands" }));
        assert!(commands_only.needs_approval("run_command"));
        assert!(!commands_only.needs_approval("workspace_edit"));

        let never = Policy::from_config(&serde_json::json!({ "askBefore": "never" }));
        assert!(!never.needs_approval("run_command"));
    }

    #[tokio::test]
    async fn the_broker_refuses_what_the_switches_did_not_allow() {
        let ws = temp_workspace("policy");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "content").unwrap();
        let off = Policy::default();

        let out = exec_under(&off, &root, "web_search", "c", "{}", "", true).await;
        assert!(out.denied);
        assert!(out.content.contains("switched off"), "{}", out.content);

        // "Never ask" is not a way to enable a class.
        let never = Policy::from_config(&serde_json::json!({ "askBefore": "never" }));
        let out = exec_under(&never, &root, "run_command", "c", "{}", "", true).await;
        assert!(out.denied);

        // Reads are untouched by all of it.
        let out = exec_under(&off, &root, "workspace_read", "c", "{\"path\":\"a.txt\"}", "", false).await;
        assert!(out.ok, "{}", out.content);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn a_gated_call_waits_for_approval_even_when_its_class_is_on() {
        let ws = temp_workspace("approval");
        let root = canonical_str(&ws);
        let all = Policy::from_config(
            &serde_json::json!({ "network": true, "files": "write", "shell": true }),
        );

        let out = exec_under(&all, &root, "run_command", "c", "{}", "", false).await;
        assert!(out.denied);
        assert!(out.content.contains("approval"), "{}", out.content);

        let never = Policy { ask: Ask::Never, ..all };
        let out = exec_under(&never, &root, "run_command", "c", "{}", "", false).await;
        assert!(!out.content.contains("approval"), "{}", out.content);
        let _ = fs::remove_dir_all(&ws);
    }

    // --- Web tools: refused until switched on, and the guard holds either way

    #[tokio::test]
    async fn web_tools_are_refused_until_web_is_switched_on() {
        let out = exec_under(&Policy::default(), "/tmp", "web_fetch", "c", "{\"url\":\"https://93.184.216.34/\"}", "", false).await;
        assert!(out.denied);
        assert!(out.content.contains("switched off"), "{}", out.content);
    }

    #[tokio::test]
    async fn a_page_on_the_local_network_is_refused_even_with_web_on() {
        let on = Policy::from_config(&serde_json::json!({ "network": true }));

        let out = exec_under(&on, "/tmp", "web_fetch", "c", "{\"url\":\"http://192.168.50.4:8888/\"}", "", false).await;
        assert!(out.denied);
        assert!(out.content.contains("private network"), "{}", out.content);

        // Reads never wait for approval, and the flag changes nothing for them.
        let out = exec_under(&on, "/tmp", "web_fetch", "c", "{\"url\":\"http://127.0.0.1/\"}", "", true).await;
        assert!(out.denied);
        assert!(out.content.contains("this computer"), "{}", out.content);
    }

    // --- workspace_write / workspace_edit -----------------------------------

    fn write_on() -> Policy {
        Policy::from_config(&serde_json::json!({ "files": "write" }))
    }

    async fn call(policy: &Policy, root: &str, tool: &str, args: &str, approved: bool) -> ToolOutcome {
        exec_under(policy, root, tool, "c", args, "", approved).await
    }

    fn json(out: &ToolOutcome) -> serde_json::Value {
        serde_json::from_str(&out.content).unwrap_or(serde_json::Value::Null)
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn a_write_creates_then_replaces_a_file_in_the_workspace() {
        let ws = temp_workspace("write");
        let root = canonical_str(&ws);
        fs::create_dir_all(ws.join("notes")).unwrap();
        let on = write_on();

        let out = call(&on, &root, "workspace_write", r#"{"path":"notes/hello.txt","content":"héllo\nworld\n"}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(fs::read_to_string(ws.join("notes").join("hello.txt")).unwrap(), "héllo\nworld\n");
        assert_eq!(json(&out)["created"], true);

        let out = call(&on, &root, "workspace_write", r#"{"path":"notes/hello.txt","content":"again"}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(fs::read_to_string(ws.join("notes").join("hello.txt")).unwrap(), "again");
        assert_eq!(json(&out)["created"], false);
        // The write leaves nothing of itself behind.
        assert_eq!(listing(&ws.join("notes")), vec!["hello.txt".to_string()]);

        // A missing folder is named; it is not created as a side effect.
        let out = call(&on, &root, "workspace_write", r#"{"path":"nope/x.txt","content":"x"}"#, true).await;
        assert!(!out.ok && !out.denied, "{}", out.content);
        assert!(out.error.unwrap().contains("not found"));

        let out = call(&on, &root, "workspace_write", r#"{"path":"notes/hello.txt"}"#, true).await;
        assert!(out.error.unwrap().contains("missing required argument"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn file_changes_need_their_switch_and_the_users_approval() {
        let ws = temp_workspace("write-gate");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "old").unwrap();
        let read = || fs::read_to_string(ws.join("a.txt")).unwrap();
        let args = r#"{"path":"a.txt","content":"new"}"#;

        // Off: refused before anything else, approval or not.
        let out = call(&Policy::default(), &root, "workspace_write", args, true).await;
        assert!(out.denied && out.content.contains("switched off"), "{}", out.content);

        // On but not approved: the file is untouched.
        let out = call(&write_on(), &root, "workspace_write", args, false).await;
        assert!(out.denied && out.content.contains("approval"), "{}", out.content);
        assert_eq!(read(), "old");

        // "Commands only" lets file changes through unasked.
        let commands_only = Policy { ask: Ask::Commands, ..write_on() };
        let out = call(&commands_only, &root, "workspace_write", args, false).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(read(), "new");

        // An edit waits for the same approval.
        let out = call(&write_on(), &root, "workspace_edit", r#"{"path":"a.txt","oldText":"new","newText":"newer"}"#, false).await;
        assert!(out.denied && out.content.contains("approval"), "{}", out.content);
        assert_eq!(read(), "new");

        let out = call(&write_on(), &root, "workspace_edit", r#"{"path":"a.txt","oldText":"new","newText":"newer"}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(read(), "newer");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn writes_stay_inside_the_workspace_and_off_credentials() {
        let ws = temp_workspace("write-escape");
        let root = canonical_str(&ws);
        fs::create_dir_all(ws.join("sub")).unwrap();
        fs::create_dir_all(ws.join("keys")).unwrap();
        fs::write(ws.join(".env"), "SECRET=1").unwrap();
        let outside = std::env::temp_dir().join("belen-write-outside.txt");
        let _ = fs::remove_file(&outside);
        let on = write_on();

        for path in ["../belen-write-outside.txt", "sub/../../belen-write-outside.txt"] {
            let out = call(&on, &root, "workspace_write", &format!(r#"{{"path":"{path}","content":"x"}}"#), true).await;
            assert!(out.denied && out.content.contains("escapes"), "{}", out.content);
            assert!(!outside.exists(), "{path} created a file outside");
        }
        for path in [".env", "keys/server.key", "sub/.env.local", "notes/.git-credentials", "id_rsa_backup"] {
            let out = call(&on, &root, "workspace_write", &format!(r#"{{"path":"{path}","content":"x"}}"#), true).await;
            assert!(out.denied && out.content.contains("credential"), "{path}: {}", out.content);
        }
        assert_eq!(fs::read_to_string(ws.join(".env")).unwrap(), "SECRET=1");

        let absolute = format!(r#"{{"path":"{}","content":"x"}}"#, outside.display());
        let out = call(&on, &root, "workspace_write", &absolute, true).await;
        assert!(out.denied && out.content.contains("absolute"), "{}", out.content);

        // A command runs from the workspace or a subfolder of it, never from
        // anywhere else — and only once allowed.
        let shell_on = Policy::from_config(&serde_json::json!({ "shell": true }));
        let echo = r#"{"command":"echo hello-from-the-tool"}"#;
        let out = call(&Policy::default(), &root, "run_command", echo, true).await;
        assert!(out.denied && out.content.contains("switched off"), "{}", out.content);
        let out = call(&shell_on, &root, "run_command", echo, false).await;
        assert!(out.denied && out.content.contains("approval"), "{}", out.content);

        for cwd in ["..", "sub/../..", "nope"] {
            let args = format!(r#"{{"command":"echo x","cwd":"{cwd}"}}"#);
            let out = call(&shell_on, &root, "run_command", &args, true).await;
            assert!(!out.ok || out.error.is_some() || out.denied, "{cwd} must not run: {}", out.content);
            assert!(out.content.contains("escapes") || out.content.contains("not found"), "{cwd}: {}", out.content);
        }

        #[cfg(unix)]
        {
            let out = call(&shell_on, &root, "run_command", echo, true).await;
            assert!(out.ok && !out.denied, "{}", out.content);
            assert!(out.content.contains("hello-from-the-tool"), "{}", out.content);
            let args = r#"{"command":"pwd","cwd":"sub"}"#;
            let out = call(&shell_on, &root, "run_command", args, true).await;
            assert!(out.content.contains("sub"), "{}", out.content);
        }

        // A folder is not something a write can replace.
        let out = call(&on, &root, "workspace_write", r#"{"path":"sub","content":"x"}"#, true).await;
        assert!(!out.ok && !out.denied);
        assert!(out.error.unwrap().contains("not a file"));
        assert!(ws.join("sub").is_dir());

        // An edit is fenced the same way.
        let out = call(&on, &root, "workspace_edit", r#"{"path":".env","oldText":"SECRET","newText":"x"}"#, true).await;
        assert!(out.denied);
        let out = call(&on, &root, "workspace_edit", r#"{"path":"../belen-write-outside.txt","oldText":"a","newText":"b"}"#, true).await;
        assert!(out.denied);
        let _ = fs::remove_dir_all(&ws);
    }

    /// A file link inside the workspace (a symlink; on Windows this needs
    /// Developer Mode).
    #[cfg(any(unix, windows))]
    fn link(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        return std::os::windows::fs::symlink_file(target, link);
    }

    /// Links inside the workspace are followed when they stay in and refused
    /// when they leave — including towards a file that does not exist yet,
    /// which is exactly the case a plain "create" would have written outside.
    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn a_write_follows_a_link_only_when_it_stays_inside() {
        let ws = temp_workspace("write-link");
        let root = canonical_str(&ws);
        let outside = temp_workspace("write-link-outside");
        fs::create_dir_all(ws.join("real")).unwrap();
        fs::write(ws.join("real").join("a.txt"), "old").unwrap();
        fs::write(outside.join("exists.txt"), "untouched").unwrap();
        // No privilege to make links: nothing here is testable.
        if link(&ws.join("real").join("a.txt"), &ws.join("inside.txt")).is_err() {
            let _ = fs::remove_dir_all(&ws);
            let _ = fs::remove_dir_all(&outside);
            return;
        }
        link(&outside.join("exists.txt"), &ws.join("outside.txt")).unwrap();
        link(&outside.join("not-yet.txt"), &ws.join("dangling.txt")).unwrap();
        let on = write_on();

        let out = call(&on, &root, "workspace_write", r#"{"path":"inside.txt","content":"new"}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(fs::read_to_string(ws.join("real").join("a.txt")).unwrap(), "new");
        assert!(fs::symlink_metadata(ws.join("inside.txt")).unwrap().file_type().is_symlink());

        for name in ["outside.txt", "dangling.txt"] {
            let args = format!(r#"{{"path":"{name}","content":"x"}}"#);
            let out = call(&on, &root, "workspace_write", &args, true).await;
            assert!(out.denied && out.content.contains("escapes"), "{name}: {}", out.content);
        }
        assert_eq!(fs::read_to_string(outside.join("exists.txt")).unwrap(), "untouched");
        assert!(!outside.join("not-yet.txt").exists(), "a dangling link wrote outside");

        let out = call(&on, &root, "workspace_edit", r#"{"path":"outside.txt","oldText":"untouched","newText":"x"}"#, true).await;
        assert!(out.denied);
        assert_eq!(fs::read_to_string(outside.join("exists.txt")).unwrap(), "untouched");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn an_edit_replaces_exactly_once_or_says_why_it_did_not() {
        let ws = temp_workspace("edit");
        let root = canonical_str(&ws);
        fs::write(ws.join("a.txt"), "one two one two\n").unwrap();
        let read = || fs::read_to_string(ws.join("a.txt")).unwrap();
        let on = write_on();

        // Ambiguous: it refuses to guess.
        let out = call(&on, &root, "workspace_edit", r#"{"path":"a.txt","oldText":"one","newText":"X"}"#, true).await;
        assert!(!out.ok && !out.denied);
        assert!(out.error.unwrap().contains("2 places"));
        assert_eq!(read(), "one two one two\n");

        let out = call(&on, &root, "workspace_edit", r#"{"path":"a.txt","oldText":"one","newText":"X","replaceAll":true}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(read(), "X two X two\n");
        assert_eq!(json(&out)["replacements"], 2);

        // Unique, and across a line break.
        fs::write(ws.join("b.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let out = call(&on, &root, "workspace_edit", r#"{"path":"b.txt","oldText":"alpha\nbeta","newText":"first\nsecond"}"#, true).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(fs::read_to_string(ws.join("b.txt")).unwrap(), "first\nsecond\ngamma\n");
        assert_eq!(json(&out)["replacements"], 1);

        // A line break the file does not have is a miss, not a near-match.
        let out = call(&on, &root, "workspace_edit", r#"{"path":"a.txt","oldText":"X two\nX two","newText":"y"}"#, true).await;
        assert!(out.error.unwrap().contains("not found"));

        let out = call(&on, &root, "workspace_edit", r#"{"path":"a.txt","oldText":"missing","newText":"y"}"#, true).await;
        assert!(out.error.unwrap().contains("not found"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn edits_refuse_what_they_cannot_do_safely() {
        let ws = temp_workspace("edit-refuse");
        let root = canonical_str(&ws);
        let on = write_on();
        macro_rules! edit {
            ($args:expr) => {
                call(&on, &root, "workspace_edit", $args, true)
            };
        }

        let out = edit!(r#"{"path":"nope.txt","oldText":"a","newText":"b"}"#).await;
        assert!(out.error.unwrap().contains("not found: nope.txt"));

        fs::write(ws.join("bin.dat"), [0xff, 0xfe, 0x00, 0x61]).unwrap();
        let out = edit!(r#"{"path":"bin.dat","oldText":"a","newText":"b"}"#).await;
        assert!(out.error.unwrap().contains("UTF-8"));

        let out = edit!(r#"{"path":"bin.dat","oldText":"","newText":"b"}"#).await;
        assert!(out.error.unwrap().contains("empty"));

        fs::write(ws.join("big.txt"), vec![b'a'; MAX_EDIT_FILE_BYTES as usize + 1]).unwrap();
        let out = edit!(r#"{"path":"big.txt","oldText":"a","newText":"b"}"#).await;
        assert!(out.error.unwrap().contains("2 MB"));

        let long = "a".repeat(MAX_OLD_TEXT_CHARS + 1);
        let out = edit!(&format!(r#"{{"path":"bin.dat","oldText":"{long}","newText":"b"}}"#)).await;
        assert!(out.error.unwrap().contains("too long"));

        let huge = "a".repeat(MAX_WRITE_BYTES + 1);
        let out = call(&on, &root, "workspace_write", &format!(r#"{{"path":"big.txt","content":"{huge}"}}"#), true).await;
        assert!(out.error.unwrap().contains("256 KB"));

        // A file with Windows line breaks keeps them on every line but the one changed.
        fs::write(ws.join("crlf.txt"), b"first\r\nsecond\r\nthird\r\n").unwrap();
        let out = edit!(r#"{"path":"crlf.txt","oldText":"second","newText":"2nd"}"#).await;
        assert!(out.ok, "{}", out.content);
        assert_eq!(fs::read(ws.join("crlf.txt")).unwrap(), b"first\r\n2nd\r\nthird\r\n");
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn a_replace_leaves_no_half_written_file() {
        let dir = temp_workspace("replace");
        let path = dir.join("a.txt");
        fs::write(&path, "old").unwrap();

        replace_file(&path, "new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(listing(&dir), vec!["a.txt".to_string()]);

        // A replace that cannot finish takes its neighbour with it.
        let folder = dir.join("folder");
        fs::create_dir(&folder).unwrap();
        assert!(replace_file(&folder, "x").is_err());
        assert_eq!(listing(&dir), vec!["a.txt".to_string(), "folder".to_string()]);
        assert!(folder.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }
}
