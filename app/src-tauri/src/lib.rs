mod db;
mod keys;
mod oauth;
mod perf;
mod provider;
mod shell;
mod tools;
mod updater;
mod web;

use db::SearchHit;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use provider::{ChatMessage, ModelInfo, ProviderSpec, StreamEvent, TestResult};
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn handle_summon(app: &tauri::AppHandle, args: &[String]) {
    if let Some(t0) = args
        .iter()
        .find_map(|a| a.strip_prefix("--summon-t0="))
        .and_then(|v| v.parse::<u64>().ok())
    {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let latency = now.saturating_sub(t0);
        if let Ok(dir) = keys::data_root() {
            let _ = std::fs::write(
                dir.join("summon.json"),
                format!("{{\"latencyMs\":{latency}}}"),
            );
        }
    }
    show_window(app);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}. BELEN is awake.")
}

#[tauri::command]
fn data_dir() -> Result<String, String> {
    keys::data_root().map(|p: PathBuf| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn key_set(name: String, value: String) -> Result<(), String> {
    keys::set(&name, value.as_bytes())
}

#[tauri::command]
fn key_get(name: String) -> Result<Option<String>, String> {
    match keys::get(&name)? {
        Some(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
fn perf_mode() -> bool {
    std::env::args().any(|a| a == "--perf")
}

#[tauri::command]
fn perf_mark_boot() {
    perf::mark_boot()
}

#[tauri::command]
fn perf_report() -> serde_json::Value {
    perf::snapshot()
}

#[tauri::command]
fn perf_write(report: serde_json::Value) -> Result<String, String> {
    let dir = keys::data_root()?;
    let path = dir.join("perf.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0)
}

#[tauri::command]
fn probe_mode() -> bool {
    std::env::args().any(|a| a == "--probe")
}

#[tauri::command]
fn probe_read() -> Result<serde_json::Value, String> {
    let path = keys::data_root()?.join("probe.json");
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn probe_write(result: serde_json::Value) -> Result<(), String> {
    let path = keys::data_root()?.join("probe-result.json");
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn provider_discover(spec: ProviderSpec) -> Result<Vec<ModelInfo>, String> {
    provider::discover(spec).await
}

#[tauri::command]
async fn provider_test(spec: ProviderSpec, model: String) -> Result<TestResult, String> {
    provider::test(spec, model).await
}

#[tauri::command]
async fn provider_stream(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    // Optional so the existing callers (probes, sub-agents) keep working.
    tools: Option<Vec<provider::ToolSchema>>,
    stream_id: Option<String>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    provider::stream(
        spec,
        model,
        system,
        messages,
        tools.unwrap_or_default(),
        stream_id.unwrap_or_default(),
        on_event,
    )
    .await
}

/// Aborts the HTTP stream registered under `stream_id`, if it is still
/// running, and marks the id as cancelled: a tool call or a command from that
/// run still in flight stops on it.
#[tauri::command]
fn provider_cancel(stream_id: String) {
    provider::cancel_stream(&stream_id)
}

/// The tool broker. Which classes may run is decided here, per call, from the
/// switches in config.json — the webview only chooses what to advertise.
/// Denials and failures come back as structured outcomes (not IPC errors) so
/// the model receives them as tool results keyed by its own call id.
/// Arguments arrive as raw JSON text and are re-parsed here: the renderer's
/// validation is convenience, not trust. `approved` is the webview's word that
/// the user okayed the call in the room; absent counts as not approved.
/// `workspace_root` is the folder Settings names, or absent when it names
/// none — the tools then work in the user's home.
#[tauri::command]
async fn tool_exec(
    workspace_root: Option<String>,
    name: String,
    call_id: String,
    args_json: String,
    stream_id: String,
    approved: Option<bool>,
) -> Result<tools::ToolOutcome, String> {
    Ok(tools::exec(
        workspace_root.as_deref(),
        &name,
        &call_id,
        &args_json,
        &stream_id,
        approved.unwrap_or(false),
    )
    .await)
}

/// The workspace when Settings names none: the user's home folder.
#[tauri::command]
fn workspace_default() -> Result<String, String> {
    tools::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .ok_or_else(|| "the home folder is unknown".to_string())
}

#[tauri::command]
async fn oauth_device_start(
    req: oauth::DeviceStartRequest,
) -> Result<oauth::DeviceStart, String> {
    oauth::device_start(req).await
}

#[tauri::command]
async fn oauth_device_poll(
    req: oauth::DevicePollRequest,
) -> Result<oauth::PollResult, String> {
    oauth::poll(req).await
}

#[tauri::command]
async fn oauth_refresh(req: oauth::RefreshRequest) -> Result<oauth::TokenSet, String> {
    oauth::refresh(req).await
}

#[tauri::command]
fn config_get() -> Result<serde_json::Value, String> {
    let path = keys::data_root()?.join("config.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn config_set(config: serde_json::Value) -> Result<(), String> {
    let path = keys::data_root()?.join("config.json");
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn room_save(room_id: String, json: String) -> Result<(), String> {
    db::save_room(&room_id, &json)
}

#[tauri::command]
fn room_load(room_id: String) -> Result<Option<String>, String> {
    db::load_room(&room_id)
}

#[tauri::command]
fn room_search(query: String) -> Result<Vec<SearchHit>, String> {
    db::search(&query)
}

#[tauri::command]
fn export_file(name: String, contents: String) -> Result<String, String> {
    let dir = keys::data_root()?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let file = if safe.is_empty() {
        "export.txt".to_string()
    } else {
        safe
    };

    let path = dir.join(file);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn update_check() -> Result<updater::CheckResult, String> {
    updater::check().await
}

#[tauri::command]
async fn update_apply(
    on_progress: Channel<updater::ApplyProgress>,
    app: tauri::AppHandle,
) -> Result<updater::UpdateInfo, String> {
    let mut emit = move |p: updater::ApplyProgress| {
        let _ = on_progress.send(p);
    };
    let info = updater::apply(&mut emit).await?;
    updater::write_applied_note(&info.version);
    // Spawn the new exe (it waits for this process), then exit so the handoff
    // completes. The Ok still reaches the webview on the way down.
    updater::relaunch(std::process::id())?;
    app.exit(0);
    Ok(info)
}

/// One-shot pending "you were updated" marker, consumed at boot.
#[tauri::command]
fn update_last() -> Result<Option<String>, String> {
    Ok(updater::take_applied_note())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else: clear update leftovers, and wait out a handoff
    // (--wait-pid) so the single-instance plugin never sees two of us.
    updater::handle_startup_args();
    perf::mark_start();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_summon(app, &args)
        }))
        .invoke_handler(tauri::generate_handler![
            greet,
            data_dir,
            key_set,
            key_get,
            perf_mode,
            perf_mark_boot,
            perf_report,
            perf_write,
            exit_app,
            probe_mode,
            probe_read,
            probe_write,
            provider_discover,
            provider_test,
            provider_stream,
            provider_cancel,
            tool_exec,
            workspace_default,
            oauth_device_start,
            oauth_device_poll,
            oauth_refresh,
            config_get,
            config_set,
            room_save,
            room_load,
            room_search,
            export_file,
            update_check,
            update_apply,
            update_last
        ])
        .setup(|app| {
            perf::mark_setup();
            let root = keys::data_root().map_err(std::io::Error::other)?;
            std::fs::create_dir_all(root.join("keys"))?;

            let show = MenuItem::with_id(app, "show", "Open BELEN", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit BELEN", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.0.as_str() {
                    "show" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building BELEN")
        .run(|_app, _event| {
            // A Dock-icon click on a hidden window reopens it. Names carry a
            // leading underscore so Windows, where the closure stays empty,
            // compiles without unused-variable warnings.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_window(_app);
            }
        });
}
