mod db;
mod keys;
mod oauth;
mod perf;
mod provider;

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
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    provider::stream(spec, model, system, messages, on_event).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            oauth_device_start,
            oauth_device_poll,
            oauth_refresh,
            config_get,
            config_set,
            room_save,
            room_load,
            room_search,
            export_file
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
                .show_menu_on_left_click(false)
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
        .run(tauri::generate_context!())
        .expect("error while running BELEN");
}
