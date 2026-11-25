//! `run_command`: one command line, run on the user's computer.
//!
//! This is the one tool with no sandbox: whatever the user's account can do,
//! the command can do. Two things stand between the model and that. The user
//! does — every call waits in the room until allowed (tools.rs `Policy`). And
//! the runner keeps the rest tidy: the workspace as the folder, a clean shell
//! with no profile of its own, a time limit that takes the whole process tree,
//! an environment with nothing in it that looks like a secret, and a stop the
//! moment the user presses Escape.
//!
//! PowerShell on Windows, zsh on macOS. Only the zsh path can run where this
//! was written; the PowerShell path is compiled by the Windows build and has
//! to be exercised by hand on the Windows machine.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::provider;
use crate::tools::ToolError;

const MAX_COMMAND_CHARS: usize = 8_000;
const DEFAULT_LIMIT_MS: u64 = 60_000;
const MIN_LIMIT_MS: u64 = 1_000;
const MAX_LIMIT_MS: u64 = 300_000;
/// Time on top of the command's own limit to kill what it started and gather
/// the output, for the caller that merely waits.
const KILL_GRACE: Duration = Duration::from_secs(10);
/// How often the runner looks at the clock, the cancel flag and the child.
const POLL: Duration = Duration::from_millis(50);
/// Output kept from each stream, and how it is split when there is too much.
const MAX_CAPTURE: usize = 256 * 1024;
const KEEP_HEAD: usize = 4_000;
const KEEP_TAIL: usize = 2_000;
/// How long after the command has ended its output pipes may take to close
/// before the runner stops waiting for the last of what they carried.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Names that hold a secret often enough that no command needs to see them.
const SECRET_MARKS: [&str; 6] = ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE"];

/// The start of every PowerShell script BELEN runs.
#[cfg(windows)]
const POWERSHELL_PRELUDE: &str = "$ErrorActionPreference = 'Continue'\n\
$ProgressPreference = 'SilentlyContinue'\n\
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n\
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n";

/// The end of it: a native command's exit code must become PowerShell's own.
#[cfg(windows)]
const POWERSHELL_EPILOGUE: &str = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n";

/// In front of every zsh command. A GUI-launched BELEN inherits almost no
/// PATH; the login shell adds what /etc/paths.d and ~/.zprofile know, and
/// this adds where the usual tools live.
#[cfg(unix)]
const ZSH_PRELUDE: &str = "export PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH\"\n";

pub fn handles(tool: &str) -> bool {
    tool == "run_command"
}

/// The bound for the caller that merely waits: never shorter than the command
/// was allowed, never unbounded if the runner itself were to hang.
pub fn outer_bound(args_raw: &str) -> Duration {
    request(args_raw)
        .map(|request| request.limit)
        .unwrap_or(Duration::from_millis(DEFAULT_LIMIT_MS))
        + KILL_GRACE
}

struct Request {
    command: String,
    limit: Duration,
}

/// The arguments, checked here as everywhere else in the broker: the
/// renderer's validation is convenience, not trust.
fn request(args_raw: &str) -> Result<Request, ToolError> {
    let args: serde_json::Value = serde_json::from_str(args_raw)
        .map_err(|_| ToolError::Failed("arguments are not valid JSON".into()))?;
    let Some(command) = args["command"].as_str() else {
        return Err(ToolError::Failed("missing required argument: command".into()));
    };
    if command.trim().is_empty() {
        return Err(ToolError::Failed("the command is empty".into()));
    }
    if command.chars().count() > MAX_COMMAND_CHARS {
        return Err(ToolError::Failed(format!(
            "the command is over {MAX_COMMAND_CHARS} characters"
        )));
    }
    // Absent means the default. Present and unreadable is a mistake, and
    // must not quietly turn into the longest or shortest wait.
    let ms = match &args["timeoutMs"] {
        serde_json::Value::Null => DEFAULT_LIMIT_MS,
        value => match value.as_u64() {
            Some(ms) => ms,
            // A negative number is a whole number that is out of range;
            // 0 is below the range too, and the check below says so.
            None if value.as_i64().is_some_and(|n| n < 0) => 0,
            None => {
                return Err(ToolError::Failed(
                    "timeoutMs must be a whole number of milliseconds".into(),
                ))
            }
        },
    };
    if !(MIN_LIMIT_MS..=MAX_LIMIT_MS).contains(&ms) {
        return Err(ToolError::Failed(format!(
            "timeoutMs must be between {MIN_LIMIT_MS} and {MAX_LIMIT_MS}"
        )));
    }
    Ok(Request {
        command: command.to_string(),
        limit: Duration::from_millis(ms),
    })
}

/// The environment a command gets: the user's own, minus anything that looks
/// like a credential. The model reads whatever a command prints, and the room
/// keeps a preview of it — a provider key must never travel that way.
fn without_secrets(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    extra_secret: Option<&str>,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(name, _)| !is_secret(name, extra_secret))
        .collect()
}

fn is_secret(name: &OsStr, extra_secret: Option<&str>) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    let named_elsewhere = extra_secret
        .map(|extra| extra.eq_ignore_ascii_case(&name))
        .unwrap_or(false);
    named_elsewhere || SECRET_MARKS.iter().any(|mark| name.contains(mark))
}

/// The environment variable the provider key is read from, when the provider
/// is set up that way. It may be called anything, so it is looked up by name.
fn provider_env_var() -> Option<String> {
    let dir = crate::keys::data_root().ok()?;
    let text = std::fs::read_to_string(dir.join("config.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json["provider"]["envVar"]
        .as_str()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// Which program to start and with what.
struct Shell {
    program: PathBuf,
    args: Vec<OsString>,
    /// A script file to remove once the command has run (Windows).
    script: Option<PathBuf>,
}

#[cfg(windows)]
fn shell_for(command: &str) -> std::io::Result<Shell> {
    // PowerShell 5.1 reads a script file by its BOM. Given on the command
    // line or through stdin, anything outside the ANSI code page arrives
    // mangled — the same trap the CI workflow works around.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let script =
        std::env::temp_dir().join(format!("belen-run-{}-{unique}.ps1", std::process::id()));
    let mut body = Vec::new();
    body.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    body.extend_from_slice(POWERSHELL_PRELUDE.as_bytes());
    body.extend_from_slice(command.as_bytes());
    body.extend_from_slice(POWERSHELL_EPILOGUE.as_bytes());
    std::fs::write(&script, body)?;

    // By its full path: given a bare name, CreateProcess looks in the working
    // directory — the workspace — before the system folders.
    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Ok(Shell {
        program: windows
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]
        .iter()
        .map(|flag| OsString::from(*flag))
        .chain(std::iter::once(script.as_os_str().to_os_string()))
        .collect(),
        script: Some(script),
    })
}

#[cfg(unix)]
fn shell_for(command: &str) -> std::io::Result<Shell> {
    Ok(if Path::new("/bin/zsh").exists() {
        // A login shell, never an interactive one: -l reads /etc/zprofile and
        // ~/.zprofile for PATH; -i would run ~/.zshrc and all it starts.
        Shell {
            program: PathBuf::from("/bin/zsh"),
            args: vec![
                OsString::from("-l"),
                OsString::from("-c"),
                OsString::from(format!("{ZSH_PRELUDE}{command}")),
            ],
            script: None,
        }
    } else {
        Shell {
            program: PathBuf::from("/bin/sh"),
            args: vec![OsString::from("-c"), OsString::from(command)],
            script: None,
        }
    })
}

#[cfg(windows)]
fn platform_setup(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // No console window flashing behind the room for every command.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn platform_setup(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // A process group of its own, so a timeout or Escape takes everything
    // the command starts along with it.
    command.process_group(0);
}

/// Output as it accumulates, shared with the thread reading the pipe.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    /// Starts reading `pipe` into the capture; `Receiver` fires when the pipe
    /// has closed.
    fn drain(self, pipe: Option<impl Read + Send + 'static>) -> (Self, Receiver<()>) {
        let (done, finished) = mpsc::channel();
        if let Some(mut pipe) = pipe {
            let capture = self.0.clone();
            // It keeps reading past the cap even once it stops keeping: a
            // writer nobody drains would block on a full pipe and never exit.
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let mut kept = capture.lock().unwrap_or_else(|p| p.into_inner());
                            let room = MAX_CAPTURE.saturating_sub(kept.len());
                            kept.extend_from_slice(&buffer[..read.min(room)]);
                        }
                    }
                }
                let _ = done.send(());
            });
        }
        (self, finished)
    }

    fn snapshot(&self) -> Vec<u8> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

struct Running {
    child: Child,
    stdout: (Capture, Receiver<()>),
    stderr: (Capture, Receiver<()>),
}

fn launch(shell: &Shell, cwd: &Path) -> std::io::Result<Running> {
    let mut command = Command::new(&shell.program);
    command
        .args(&shell.args)
        .current_dir(cwd)
        .env_clear()
        .envs(without_secrets(std::env::vars_os(), provider_env_var().as_deref()))
        // Tools that can, print in UTF-8 rather than the console code page.
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform_setup(&mut command);

    let mut child = command.spawn()?;
    let stdout = Capture::default().drain(child.stdout.take());
    let stderr = Capture::default().drain(child.stderr.take());
    Ok(Running {
        child,
        stdout,
        stderr,
    })
}

/// Ends the command and everything it started. A dev server or a test runner
/// left behind would outlive the tool call that began it.
#[cfg(unix)]
fn kill_tree(child: &mut Child) {
    // The negated id is the process group, which the child leads.
    let group = format!("-{}", child.id());
    let _ = Command::new("/bin/kill")
        .args(["-KILL", "--", &group])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let taskkill = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("taskkill.exe");
    // `/T` takes the children with it.
    let _ = Command::new(&taskkill)
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

enum End {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

/// Runs one command and waits for it, for its limit, or for the user.
pub async fn run(cwd: &Path, args_raw: &str, stream_id: &str) -> Result<(String, bool), ToolError> {
    let request = request(args_raw)?;
    let shell = shell_for(&request.command)
        .map_err(|e| ToolError::Failed(format!("the command could not be prepared: {e}")))?;

    let result = match launch(&shell, cwd) {
        Err(e) => Err(ToolError::Failed(format!(
            "the command could not be started: {e}"
        ))),
        Ok(mut running) => supervise(&mut running, &request, stream_id).await,
    };
    if let Some(script) = &shell.script {
        let _ = std::fs::remove_file(script);
    }
    result
}

async fn supervise(
    running: &mut Running,
    request: &Request,
    stream_id: &str,
) -> Result<(String, bool), ToolError> {
    let started = Instant::now();
    let deadline = started + request.limit;

    let end = loop {
        if let Ok(Some(status)) = running.child.try_wait() {
            break End::Exited(status);
        }
        if provider::is_cancelled(stream_id) {
            break End::Cancelled;
        }
        if Instant::now() >= deadline {
            break End::TimedOut;
        }
        tokio::time::sleep(POLL).await;
    };

    if matches!(end, End::Exited(_)) {
        // The pipes close when their last holder exits. Something the command
        // left running may hold one open, so this waits only so long.
        for finished in [&running.stdout.1, &running.stderr.1] {
            let _ = finished.recv_timeout(PIPE_GRACE);
        }
    } else {
        kill_tree(&mut running.child);
        let _ = running.child.wait();
        // A moment for what was written before the end to land.
        for finished in [&running.stdout.1, &running.stderr.1] {
            let _ = finished.recv_timeout(Duration::from_millis(250));
        }
    }

    let stdout = text(&running.stdout.0.snapshot());
    let stderr = text(&running.stderr.0.snapshot());
    let truncated = stdout.1 || stderr.1;
    let content = serde_json::json!({
        "command": request.command,
        "exitCode": match &end {
            End::Exited(status) => serde_json::json!(status.code()),
            _ => serde_json::Value::Null,
        },
        "timedOut": matches!(end, End::TimedOut),
        "durationMs": started.elapsed().as_millis() as u64,
        "stdout": stdout.0,
        "stderr": stderr.0,
        "truncated": truncated,
    })
    .to_string();

    if matches!(end, End::Cancelled) {
        return Err(ToolError::Denied("cancelled".into()));
    }
    Ok((content, truncated))
}

/// Bytes to the text the room and the model read: UTF-8, no byte-order mark,
/// and with the middle dropped rather than the end when there is too much.
fn text(bytes: &[u8]) -> (String, bool) {
    let stripped = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    clip(&String::from_utf8_lossy(stripped))
}

fn clip(text: &str) -> (String, bool) {
    let total = text.chars().count();
    if total <= KEEP_HEAD + KEEP_TAIL {
        return (text.to_string(), false);
    }
    let head: String = text.chars().take(KEEP_HEAD).collect();
    let tail: String = text.chars().skip(total - KEEP_TAIL).collect();
    let omitted = total - KEEP_HEAD - KEEP_TAIL;
    (
        format!("{head}\n… ({omitted} characters omitted) …\n{tail}"),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_is_secret(name: &str, extra: Option<&str>) -> bool {
        is_secret(OsStr::new(name), extra)
    }

    fn pair(name: &str, value: &str) -> (OsString, OsString) {
        (OsString::from(name), OsString::from(value))
    }

    fn names_of(vars: &[(OsString, OsString)]) -> Vec<String> {
        vars.iter()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn nothing_that_looks_like_a_credential_reaches_a_command() {
        for name in [
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "DB_PASSWORD",
            "npm_config_passphrase",
            "HF_TOKEN",
        ] {
            assert!(env_is_secret(name, None), "{name} is a secret");
        }
        // However it is spelled.
        assert!(env_is_secret("openai_api_key", None));
        assert!(env_is_secret("Zai-Coding-Key", None));

        for name in [
            "PATH", "HOME", "SHEll", "LANG", "SSH_AUTH_SOCK", "TERM_PROGRAM", "TMPDIR",
        ] {
            assert!(!env_is_secret(name, None), "{name} is not a secret");
        }
    }

    #[test]
    fn the_providers_own_variable_goes_whatever_it_is_called() {
        assert!(env_is_secret("ZAI", Some("ZAI")));
        assert!(env_is_secret("zai", Some("ZAI")));
        assert!(env_is_secret("PATH", Some("PATH")), "even a name that looks harmless");
        assert!(!env_is_secret("ZAI_BACKUP", Some("ZAI")), "only that one name");
    }

    #[test]
    fn the_environment_is_passed_through_minus_the_secrets() {
        let kept = without_secrets(
            [
                pair("PATH", "/usr/bin"),
                pair("HOME", "/Users/someone"),
                pair("OPENAI_API_KEY", "sk-do-not-print"),
                pair("GITHUB_TOKEN", "ghp_do-not-print"),
                pair("MY_PROVIDER_CREDENTIAL", "zai-do-not-print"),
            ],
            Some("MY_PROVIDER_CREDENTIAL"),
        );
        assert_eq!(names_of(&kept), ["PATH", "HOME"]);
    }

    #[test]
    fn arguments_are_checked_here_too() {
        let plain = request(r#"{"command":"ls"}"#).unwrap();
        assert_eq!(plain.command, "ls");
        assert_eq!(plain.limit, Duration::from_millis(DEFAULT_LIMIT_MS));
        assert_eq!(
            request(r#"{"command":"ls","timeoutMs":5000}"#).unwrap().limit,
            Duration::from_secs(5)
        );

        let long = format!(r#"{{"command":"{}"}}"#, "x".repeat(MAX_COMMAND_CHARS + 1));
        for (args, expected) in [
            ("{}", "missing required argument"),
            (r#"{"command":"   "}"#, "empty"),
            (long.as_str(), "over"),
            (r#"{"command":"ls","timeoutMs":999}"#, "between"),
            (r#"{"command":"ls","timeoutMs":300001}"#, "between"),
            (r#"{"command":"ls","timeoutMs":2.5}"#, "whole number"),
            (r#"{"command":"ls","timeoutMs":"3000"}"#, "whole number"),
            (r#"{"command":"ls","timeoutMs":-1}"#, "between"),
            ("{not json", "valid JSON"),
        ] {
            let reason = match request(args).err().expect("must be refused") {
                ToolError::Failed(reason) | ToolError::Denied(reason) => reason,
            };
            assert!(reason.contains(expected), "{args}: {reason}");
        }
    }

    #[test]
    fn the_outer_bound_always_covers_the_command() {
        assert!(outer_bound(r#"{"command":"ls","timeoutMs":300000}"#) > Duration::from_secs(300));
        assert!(outer_bound("{not json") >= Duration::from_secs(60));
        assert!(handles("run_command") && !handles("workspace_write"));
    }

    #[test]
    fn output_is_utf8_without_a_byte_order_mark_and_keeps_both_ends() {
        assert_eq!(text(&[0xef, 0xbb, 0xbf, b'h', b'i']), ("hi".to_string(), false));
        assert_eq!(text("café ✓".as_bytes()).0, "café ✓");
        assert_eq!(text(&[0xff, 0xfe]).0, "\u{fffd}\u{fffd}");

        let flooded = format!("{}{}", "é".repeat(KEEP_HEAD + 500), "z".repeat(KEEP_TAIL));
        let (cut, was_cut) = clip(&flooded);
        assert!(was_cut);
        assert!(cut.starts_with(&"é".repeat(KEEP_HEAD)));
        assert!(cut.contains("(500 characters omitted)"));
        assert!(cut.ends_with(&"z".repeat(KEEP_TAIL)));
        assert_eq!(clip("short"), ("short".to_string(), false));
    }

    // --- The zsh path, where it can run -------------------------------------

    #[cfg(unix)]
    fn workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("belen-shell-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[cfg(unix)]
    async fn sh(cwd: &Path, command: &str, timeout_ms: u64) -> serde_json::Value {
        let args = serde_json::json!({ "command": command, "timeoutMs": timeout_ms }).to_string();
        let (content, _) = run(cwd, &args, "").await.expect("the command ran");
        serde_json::from_str(&content).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_runs_in_the_workspace_and_reports_its_output() {
        let dir = workspace("run");
        std::fs::write(dir.join("marker.txt"), "x").unwrap();

        let out = sh(&dir, "ls marker.txt && pwd", 10_000).await;
        assert_eq!(out["exitCode"], 0, "{out}");
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.contains("marker.txt"), "{out}");
        assert!(stdout.contains(dir.to_str().unwrap()), "{out}");
        assert_eq!(out["timedOut"], false, "{out}");
        assert_eq!(out["truncated"], false, "{out}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn text_outside_ascii_survives_the_trip() {
        let dir = workspace("utf8");
        let out = sh(&dir, "printf 'café ✓ — héllo'", 10_000).await;
        assert_eq!(out["stdout"], "café ✓ — héllo", "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_exit_code_and_the_error_stream_are_reported() {
        let dir = workspace("exit");
        let out = sh(&dir, "echo oops >&2; exit 3", 10_000).await;
        assert_eq!(out["exitCode"], 3, "{out}");
        assert_eq!(out["stdout"], "", "{out}");
        assert!(out["stderr"].as_str().unwrap().contains("oops"), "{out}");

        let out = sh(&dir, "no-such-command-belen-xyz", 10_000).await;
        assert_ne!(out["exitCode"], 0, "{out}");
        assert!(!out["stderr"].as_str().unwrap().is_empty(), "{out}");

        // A native command's status is the shell's: this is what the
        // PowerShell epilogue reproduces there.
        let out = sh(&dir, "false", 10_000).await;
        assert_ne!(out["exitCode"], 0, "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// True while some process has `token` on its command line.
    #[cfg(unix)]
    fn alive(token: &str) -> bool {
        Command::new("/usr/bin/pgrep")
            .args(["-f", token])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    async fn gone(token: &str) -> bool {
        for _ in 0..60 {
            if !alive(token) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[cfg(unix)]
    fn token(tag: &str) -> String {
        format!("belen-{tag}-{}-{:x}", std::process::id(), Instant::now().elapsed().as_nanos())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_past_its_limit_is_stopped_with_everything_it_started() {
        let dir = workspace("timeout");
        let token = token("tree");
        // One subshell in the background, a shell that starts a sleeper in
        // the background, and a sleeper in the foreground: a limit that only
        // ended the leader would leave the sleeper and its parent behind.
        let command = format!(
            "(sleep 31) & /bin/sh -c 'sleep 31 # {token}' & sleep 31; echo far-too-late"
        );
        let started = Instant::now();
        let out = sh(&dir, &command, 1_500).await;

        assert_eq!(out["timedOut"], true, "{out}");
        assert!(out["exitCode"].is_null(), "{out}");
        assert!(started.elapsed() < Duration::from_secs(20), "the limit was enforced");
        assert!(!out["stdout"].as_str().unwrap().contains("far-too-late"), "{out}");

        // The whole tree is gone, once the kernel has reaped it.
        assert!(gone(&token).await, "a process from the command outlived its limit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pressing_escape_stops_a_running_command() {
        let dir = workspace("cancel");
        let token = token("cancel");
        provider::cancel_stream("escape-pressed");

        let args = serde_json::json!({
            "command": format!("sleep 30; echo {token}"),
            "timeoutMs": 60_000,
        })
        .to_string();
        let started = Instant::now();
        let out = run(&dir, &args, "escape-pressed").await;
        assert!(out.is_err(), "a cancelled command reports as cancelled");
        assert!(started.elapsed() < Duration::from_secs(10));

        assert!(gone(&token).await, "the command kept running after Escape");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_floods_finishes_and_is_cut() {
        let dir = workspace("flood");
        let started = Instant::now();
        let out = sh(&dir, "head -c 900000 /dev/zero | tr '\\0' 'x'; echo END", 20_000).await;

        assert_eq!(out["exitCode"], 0, "{out}");
        assert_eq!(out["timedOut"], false, "{out}");
        assert_eq!(out["truncated"], true, "{out}");
        // What the model reads is a little of the start, a note, a little of
        // the end of what was kept — never the flood itself.
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.len() < KEEP_HEAD + KEEP_TAIL + 100, "{} characters", stdout.len());
        assert!(stdout.contains("characters omitted"), "{out}");
        assert!(started.elapsed() < Duration::from_secs(15));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_cannot_start_says_so() {
        let out = run(Path::new("/no/such/folder-belen"), r#"{"command":"ls"}"#, "").await;
        let reason = match out.err().expect("must fail") {
            ToolError::Failed(reason) | ToolError::Denied(reason) => reason,
        };
        assert!(reason.contains("could not be started"), "{reason}");
    }

    // --- The PowerShell path: compiled on Windows, run by hand there -------

    #[cfg(windows)]
    #[tokio::test]
    async fn a_command_runs_in_the_workspace_and_reports_its_output() {
        let dir = std::env::temp_dir().join(format!("belen-shell-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "x").unwrap();
        let root = dir.canonicalize().unwrap();

        let args = r#"{"command":"Get-ChildItem -Name marker.txt; (Get-Location).Path","timeoutMs":30000}"#;
        let (content, _) = run(&root, args, "").await.expect("the command ran");
        let out: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(out["exitCode"], 0, "{out}");
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.contains("marker.txt"), "{out}");
        assert!(stdout.contains("belen-shell-win"), "{out}");

        // Text outside ASCII, as PowerShell 5.1 reads it from the script and
        // as it writes it back out.
        let args = r#"{"command":"Write-Output \"café ✓\"","timeoutMs":30000}"#;
        let (content, _) = run(&root, args, "").await.expect("ran");
        let out: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(out["stdout"].as_str().unwrap().trim(), "café ✓", "{out}");

        // A native command's exit code becomes the command's.
        let args = r#"{"command":"cmd /c exit 3","timeoutMs":30000}"#;
        let (content, _) = run(&root, args, "").await.expect("ran");
        let out: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(out["exitCode"], 3, "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
