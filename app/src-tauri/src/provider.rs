use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::Notify;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// apiKey | bearer | env | header | none. Absent falls back to the kind defaults.
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub header_name: Option<String>,
    #[serde(default)]
    pub env_var: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub ttft_ms: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
// `rename_all` covers the variant names; `rename_all_fields` the fields inside
// them — without it `call_id` reaches the webview as snake_case and tool_exec
// rejects the invoke (missing required key `callId`).
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Token { text: String },
    /// One fully assembled tool call (fragments already joined by call index).
    ToolCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    Done { usage: Option<serde_json::Value> },
    Error { message: String },
}

/// A tool call the model issued, carried on assistant history messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// assistant message → the tool calls it issued.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// role "tool" → the call id this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// role "tool" → tool name (Google's functionResponse needs it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Tool schema advertised to providers that support tool calling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
}

/// Deny-by-default stream cancellation. `cancel_stream` removes the entry and
/// flips the flag; `wait()` is race-free because `notify_one` stores a permit
/// even when no one is waiting yet.
pub struct CancelSignal {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelSignal {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn trigger(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    async fn wait(&self) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        self.notify.notified().await;
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<CancelSignal>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<CancelSignal>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How many cancelled stream ids are remembered. Ids are unique per send, and
/// the renderer drops a cancelled run's events long before this many more
/// sends have passed.
const CANCELLED_MEMORY: usize = 64;

/// The streams the user cancelled, oldest first.
///
/// A stream's registry entry is removed when it ends, however it ended — and a
/// tool call is only ever dispatched after its stream has ended — so "no
/// longer registered" cannot mean "cancelled". Before this list existed every
/// tool call in the running app was refused as cancelled.
#[derive(Default)]
struct CancelledStreams {
    ids: VecDeque<String>,
}

impl CancelledStreams {
    fn remember(&mut self, id: &str) {
        if self.contains(id) {
            return;
        }
        if self.ids.len() >= CANCELLED_MEMORY {
            self.ids.pop_front();
        }
        self.ids.push_back(id.to_string());
    }

    fn contains(&self, id: &str) -> bool {
        self.ids.iter().any(|known| known == id)
    }
}

fn cancelled_streams() -> &'static Mutex<CancelledStreams> {
    static CANCELLED: OnceLock<Mutex<CancelledStreams>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(CancelledStreams::default()))
}

pub fn register_stream(stream_id: &str) -> Arc<CancelSignal> {
    let signal = Arc::new(CancelSignal::new());
    if !stream_id.is_empty() {
        if let Ok(mut guard) = registry().lock() {
            guard.insert(stream_id.to_string(), signal.clone());
        }
    }
    signal
}

/// Aborts the HTTP stream registered under `stream_id` if it is still running,
/// and remembers the id as cancelled either way: a tool call already in
/// flight, or a command still running, checks for exactly that.
pub fn cancel_stream(stream_id: &str) {
    if stream_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = registry().lock() {
        if let Some(signal) = guard.remove(stream_id) {
            signal.trigger();
        }
    }
    if let Ok(mut cancelled) = cancelled_streams().lock() {
        cancelled.remember(stream_id);
    }
}

/// Used by the tool broker and the command runner: true only for a stream the
/// user cancelled. Empty ids (legacy callers) never count as cancelled.
pub fn is_cancelled(stream_id: &str) -> bool {
    if stream_id.is_empty() {
        return false;
    }
    match cancelled_streams().lock() {
        Ok(cancelled) => cancelled.contains(stream_id),
        Err(_) => false,
    }
}

pub(crate) fn finish_stream(stream_id: &str) {
    if stream_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = registry().lock() {
        guard.remove(stream_id);
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Pulls complete '\n'-terminated lines out of `buffer`, decoding each line
/// only once it is whole. A multi-byte UTF-8 character split across network
/// chunks can never straddle a newline (continuation bytes are >= 0x80), so
/// decoding whole lines kills the per-chunk lossy-decode mojibake. Returns
/// Ok(false) when the handler says the stream is finished ([DONE] /
/// message_stop / channel closed); the caller stops pumping.
fn drain_lines(
    buffer: &mut Vec<u8>,
    mut on_line: impl FnMut(&str) -> Result<bool, String>,
) -> Result<bool, String> {
    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
        let mut line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
        line_bytes.pop(); // the newline
        if line_bytes.last() == Some(&b'\r') {
            line_bytes.pop();
        }
        let line = String::from_utf8_lossy(&line_bytes).into_owned();
        if !on_line(&line)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn apply_auth(
    mut req: reqwest::RequestBuilder,
    spec: &ProviderSpec,
) -> reqwest::RequestBuilder {
    for (key, value) in &spec.headers {
        req = req.header(key, value);
    }

    match spec.auth.as_deref() {
        Some("none") => return req,
        Some("env") => {
            let Some(var) = &spec.env_var else { return req };
            let Ok(token) = std::env::var(var) else { return req };
            return match spec.kind.as_str() {
                "anthropic" => req
                    .header("x-api-key", token)
                    .header("anthropic-version", "2023-06-01"),
                "google" => req.header("x-goog-api-key", token),
                _ => req.header("Authorization", format!("Bearer {token}")),
            };
        }
        Some("header") => {
            if let (Some(name), Some(value)) = (&spec.header_name, &spec.api_key) {
                return req.header(name, value);
            }
            return req;
        }
        Some("bearer") => {
            if let Some(key) = &spec.api_key {
                return req.header("Authorization", format!("Bearer {key}"));
            }
            return req;
        }
        _ => {}
    }

    match spec.kind.as_str() {
        "anthropic" => {
            if let Some(key) = &spec.api_key {
                req = req.header("x-api-key", key);
            }
            req = req.header("anthropic-version", "2023-06-01");
        }
        "google" => {
            if let Some(key) = &spec.api_key {
                req = req.header("x-goog-api-key", key);
            }
        }
        _ => {
            if let Some(key) = &spec.api_key {
                req = req.header("Authorization", format!("Bearer {key}"));
            }
        }
    }

    req
}

fn base(spec: &ProviderSpec) -> String {
    spec.base_url.trim_end_matches('/').to_string()
}

pub async fn discover(spec: ProviderSpec) -> Result<Vec<ModelInfo>, String> {
    let url = match spec.kind.as_str() {
        "anthropic" => format!("{}/v1/models?limit=100", base(&spec)),
        "google" => format!("{}/models?pageSize=100", base(&spec)),
        "ollama" => format!("{}/api/tags", base(&spec)),
        _ => format!("{}/models", base(&spec)),
    };

    let response = apply_auth(client()?.get(&url), &spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models = match spec.kind.as_str() {
        "google" | "ollama" => json["models"].as_array().cloned().unwrap_or_default(),
        _ => json["data"].as_array().cloned().unwrap_or_default(),
    };

    Ok(models
        .iter()
        .filter_map(|m| {
            let id = match spec.kind.as_str() {
                "google" => m["name"].as_str()?.trim_start_matches("models/").to_string(),
                "ollama" => m["name"].as_str()?.to_string(),
                _ => m["id"].as_str()?.to_string(),
            };

            let label = match spec.kind.as_str() {
                "google" => m["displayName"].as_str().unwrap_or(&id).to_string(),
                "ollama" => m
                    .get("details")
                    .and_then(|d| d.get("family"))
                    .and_then(|f| f.as_str())
                    .map(|family| format!("{id} · {family}"))
                    .unwrap_or_else(|| id.clone()),
                "anthropic" => m["display_name"].as_str().unwrap_or(&id).to_string(),
                _ => id.clone(),
            };

            let context_window = m["context_length"]
                .as_u64()
                .or_else(|| m["context_window"].as_u64())
                .or_else(|| m["input_token_limit"].as_u64())
                .map(|v| v as u32);

            Some(ModelInfo {
                id,
                label,
                context_window,
            })
        })
        .collect())
}

pub async fn test(spec: ProviderSpec, model: String) -> Result<TestResult, String> {
    let started = Instant::now();
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: "Reply with exactly one word: ok".into(),
        tool_calls: Vec::new(),
        tool_call_id: None,
        name: None,
    }];

    let text = match spec.kind.as_str() {
        "anthropic" => test_anthropic(&spec, &model, &messages).await?,
        "google" => test_google(&spec, &model, &messages).await?,
        _ => test_openai(&spec, &model, &messages).await?,
    };

    Ok(TestResult {
        ok: true,
        ttft_ms: started.elapsed().as_millis() as u64,
        text,
        error: None,
    })
}

async fn test_openai(
    spec: &ProviderSpec,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base(spec));
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": 8,
        "stream": false,
    });

    let response = apply_auth(client()?.post(&url).json(&body), spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn test_anthropic(
    spec: &ProviderSpec,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String, String> {
    let url = format!("{}/v1/messages", base(spec));
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8,
        "messages": messages,
    });

    let response = apply_auth(client()?.post(&url).json(&body), spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(json["content"][0]["text"].as_str().unwrap_or("").to_string())
}

async fn test_google(
    spec: &ProviderSpec,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String, String> {
    let url = format!("{}/models/{model}:generateContent", base(spec));
    let body = serde_json::json!({
        "contents": google_contents(messages),
    });

    let response = apply_auth(client()?.post(&url).json(&body), spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

// ---------------------------------------------------------------------------
// History mapping: the provider-neutral ChatMessage list → each wire format.
// ---------------------------------------------------------------------------

fn openai_history(system: &Option<String>, messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(s) = system {
        out.push(serde_json::json!({ "role": "system", "content": s }));
    }
    for m in messages {
        let mut msg = serde_json::json!({ "role": m.role, "content": m.content });
        if !m.tool_calls.is_empty() {
            msg["tool_calls"] = serde_json::json!(m
                .tool_calls
                .iter()
                .map(|c| serde_json::json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.arguments }
                }))
                .collect::<Vec<_>>());
            if m.content.is_empty() {
                msg["content"] = serde_json::Value::Null;
            }
        }
        if let Some(id) = &m.tool_call_id {
            msg["tool_call_id"] = serde_json::json!(id);
        }
        out.push(msg);
    }
    out
}

fn anthropic_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
                }
                for c in &m.tool_calls {
                    let input: serde_json::Value =
                        serde_json::from_str(&c.arguments).unwrap_or(serde_json::json!({}));
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": c.id,
                        "name": c.name,
                        "input": input,
                    }));
                }
                if blocks.is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": "" }));
                }
                out.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            }
            "tool" => {
                let result = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content,
                });
                // Consecutive tool results ride in one user message.
                match out.last_mut() {
                    Some(last) if last["role"] == "user" => {
                        if let Some(arr) = last["content"].as_array_mut() {
                            arr.push(result);
                            continue;
                        }
                        out.push(serde_json::json!({ "role": "user", "content": [result] }));
                    }
                    _ => out.push(serde_json::json!({ "role": "user", "content": [result] })),
                }
            }
            role => out.push(serde_json::json!({ "role": role, "content": m.content })),
        }
    }
    out
}

fn google_contents(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| {
            // Gemini speaks "model"/"user", never "assistant"; tool results
            // ride in a user message as functionResponse parts.
            let role = match m.role.as_str() {
                "assistant" => "model",
                "tool" => "user",
                other => other,
            };
            let mut parts: Vec<serde_json::Value> = Vec::new();
            // For tool results the content IS the functionResponse payload;
            // never also emit it as a text part.
            if !m.content.is_empty() && m.role != "tool" {
                parts.push(serde_json::json!({ "text": m.content }));
            }
            for c in &m.tool_calls {
                let args: serde_json::Value =
                    serde_json::from_str(&c.arguments).unwrap_or(serde_json::json!({}));
                parts.push(serde_json::json!({
                    "functionCall": { "name": c.name, "args": args }
                }));
            }
            if m.role == "tool" {
                let payload: serde_json::Value = serde_json::from_str(&m.content)
                    .unwrap_or(serde_json::json!({ "result": m.content }));
                parts.push(serde_json::json!({
                    "functionResponse": {
                        "name": m.name.clone().unwrap_or_else(|| "unknown_tool".into()),
                        "response": payload,
                    }
                }));
            }
            if parts.is_empty() {
                parts.push(serde_json::json!({ "text": m.content }));
            }
            serde_json::json!({ "role": role, "parts": parts })
        })
        .collect()
}

/// Gemini rejects `additionalProperties` in parameter schemas; strip it.
fn strip_additional_properties(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if k == "additionalProperties" {
                    continue;
                }
                out.insert(k.clone(), strip_additional_properties(v));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------
// Streaming with tool-call assembly + cancellation.
// ---------------------------------------------------------------------------

/// Fragments of one tool call being assembled across stream chunks.
#[derive(Default, Clone)]
struct ToolAcc {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

pub async fn stream(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSchema>,
    stream_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let cancel = register_stream(&stream_id);
    let result = match spec.kind.as_str() {
        "anthropic" => {
            stream_anthropic(spec, model, system, messages, tools, cancel, on_event).await
        }
        "google" => stream_google(spec, model, system, messages, tools, cancel, on_event).await,
        _ => stream_openai(spec, model, system, messages, tools, cancel, on_event).await,
    };
    finish_stream(&stream_id);
    result
}

/// Sends the request, aborting if the stream is cancelled mid-connect.
async fn send_with_cancel(
    req: reqwest::RequestBuilder,
    cancel: &Arc<CancelSignal>,
) -> Result<reqwest::Response, String> {
    tokio::select! {
        r = req.send() => r.map_err(|e| e.to_string()),
        _ = cancel.wait() => Err("cancelled".into()),
    }
}

fn openai_tool_schemas(tools: &[ToolSchema]) -> serde_json::Value {
    serde_json::json!(tools
        .iter()
        .map(|t| serde_json::json!({
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
        }))
        .collect::<Vec<_>>())
}

fn anthropic_tool_schemas(tools: &[ToolSchema]) -> serde_json::Value {
    serde_json::json!(tools
        .iter()
        .map(|t| serde_json::json!({
            "name": t.name,
            "description": t.description,
            "input_schema": t.parameters,
        }))
        .collect::<Vec<_>>())
}

fn google_tool_schemas(tools: &[ToolSchema]) -> serde_json::Value {
    serde_json::json!([{ "functionDeclarations": tools
        .iter()
        .map(|t| serde_json::json!({
            "name": t.name,
            "description": t.description,
            "parameters": strip_additional_properties(&t.parameters),
        }))
        .collect::<Vec<_>>() }])
}

fn collect_openai_tool_delta(value: &serde_json::Value, calls: &mut BTreeMap<u64, ToolAcc>) {
    let Some(list) = value["choices"][0]["delta"]["tool_calls"].as_array() else {
        return;
    };
    for (position, tc) in list.iter().enumerate() {
        let index = tc["index"].as_u64().unwrap_or(position as u64);
        let entry = calls.entry(index).or_default();
        if let Some(id) = tc["id"].as_str() {
            if !id.is_empty() {
                entry.id.get_or_insert(id.to_string());
            }
        }
        if let Some(name) = tc["function"]["name"].as_str() {
            if !name.is_empty() {
                entry.name.get_or_insert(name.to_string());
            }
        }
        if let Some(fragment) = tc["function"]["arguments"].as_str() {
            entry.arguments.push_str(fragment);
        }
    }
}

fn flush_openai_tools(calls: &BTreeMap<u64, ToolAcc>, on_event: &Channel<StreamEvent>) {
    for (index, acc) in calls {
        let id = acc
            .id
            .clone()
            .unwrap_or_else(|| format!("call_{index}"));
        let name = acc
            .name
            .clone()
            .unwrap_or_else(|| format!("tool_{index}"));
        let _ = on_event.send(StreamEvent::ToolCall {
            call_id: id,
            name,
            arguments: acc.arguments.clone(),
        });
    }
}

async fn stream_openai(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSchema>,
    cancel: Arc<CancelSignal>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", base(&spec));
    let history = openai_history(&system, &messages);
    let mut body = serde_json::json!({ "model": model, "messages": history, "stream": true });
    if !tools.is_empty() {
        body["tools"] = openai_tool_schemas(&tools);
    }

    let http = client()?;
    let response = send_with_cancel(apply_auth(http.post(&url).json(&body), &spec), &cancel).await?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut calls: BTreeMap<u64, ToolAcc> = BTreeMap::new();

    loop {
        if cancel.cancelled.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        tokio::select! {
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buffer.extend_from_slice(&chunk);

                let mut finished = false;
                drain_lines(&mut buffer, |line| {
                    if line.is_empty() || line.starts_with(':') {
                        return Ok(true);
                    }
                    let Some(data) = line.strip_prefix("data:") else {
                        return Ok(true);
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        return Ok(true);
                    }
                    if data == "[DONE]" {
                        flush_openai_tools(&calls, &on_event);
                        let _ = on_event.send(StreamEvent::Done { usage: None });
                        finished = true;
                        return Ok(false);
                    }

                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
                            if !text.is_empty() {
                                if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                                    finished = true;
                                    return Ok(false);
                                }
                            }
                        }
                        collect_openai_tool_delta(&value, &mut calls);
                    }
                    Ok(true)
                })?;
                if finished {
                    return Ok(());
                }
            }
            _ = cancel.wait() => { return Err("cancelled".into()); }
        }
    }

    flush_openai_tools(&calls, &on_event);
    let _ = on_event.send(StreamEvent::Done { usage: None });
    Ok(())
}

async fn stream_anthropic(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSchema>,
    cancel: Arc<CancelSignal>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/v1/messages", base(&spec));
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "messages": anthropic_messages(&messages),
        "stream": true,
    });
    if let Some(s) = system {
        body["system"] = serde_json::Value::String(s);
    }
    if !tools.is_empty() {
        body["tools"] = anthropic_tool_schemas(&tools);
    }

    let http = client()?;
    let response = send_with_cancel(apply_auth(http.post(&url).json(&body), &spec), &cancel).await?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut calls: BTreeMap<u64, ToolAcc> = BTreeMap::new();

    loop {
        if cancel.cancelled.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        tokio::select! {
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buffer.extend_from_slice(&chunk);

                let mut finished = false;
                drain_lines(&mut buffer, |line| {
                    let Some(data) = line.strip_prefix("data:") else {
                        return Ok(true);
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        return Ok(true);
                    }

                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                        match value["type"].as_str().unwrap_or("") {
                            "content_block_start" => {
                                if value["content_block"]["type"] == "tool_use" {
                                    let index = value["index"].as_u64().unwrap_or(0);
                                    calls.insert(index, ToolAcc {
                                        id: value["content_block"]["id"].as_str().map(str::to_string),
                                        name: value["content_block"]["name"].as_str().map(str::to_string),
                                        arguments: String::new(),
                                    });
                                }
                            }
                            "content_block_delta" => {
                                if let Some(text) = value["delta"]["text"].as_str() {
                                    if !text.is_empty() {
                                        if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                                            finished = true;
                                            return Ok(false);
                                        }
                                    }
                                }
                                if let Some(fragment) = value["delta"]["partial_json"].as_str() {
                                    let index = value["index"].as_u64().unwrap_or(0);
                                    if let Some(acc) = calls.get_mut(&index) {
                                        acc.arguments.push_str(fragment);
                                    }
                                }
                            }
                            "content_block_stop" => {
                                let index = value["index"].as_u64().unwrap_or(0);
                                if let Some(acc) = calls.remove(&index) {
                                    let id = acc.id.unwrap_or_else(|| format!("call_{index}"));
                                    let name = acc.name.unwrap_or_else(|| format!("tool_{index}"));
                                    let _ = on_event.send(StreamEvent::ToolCall {
                                        call_id: id,
                                        name,
                                        arguments: acc.arguments,
                                    });
                                }
                            }
                            "message_stop" => {
                                let _ = on_event.send(StreamEvent::Done { usage: None });
                                finished = true;
                                return Ok(false);
                            }
                            _ => {}
                        }
                    }
                    Ok(true)
                })?;
                if finished {
                    return Ok(());
                }
            }
            _ = cancel.wait() => { return Err("cancelled".into()); }
        }
    }

    let _ = on_event.send(StreamEvent::Done { usage: None });
    Ok(())
}

async fn stream_google(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    tools: Vec<ToolSchema>,
    cancel: Arc<CancelSignal>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/models/{model}:streamGenerateContent?alt=sse", base(&spec));
    let mut body = serde_json::json!({ "contents": google_contents(&messages) });
    if let Some(s) = system {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": s }] });
    }
    if !tools.is_empty() {
        body["tools"] = google_tool_schemas(&tools);
    }

    let http = client()?;
    let response = send_with_cancel(apply_auth(http.post(&url).json(&body), &spec), &cancel).await?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut google_seq: u64 = 0;

    loop {
        if cancel.cancelled.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        tokio::select! {
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| e.to_string())?;
                buffer.extend_from_slice(&chunk);

                let mut finished = false;
                drain_lines(&mut buffer, |line| {
                    let Some(data) = line.strip_prefix("data:") else {
                        return Ok(true);
                    };
                    let data = data.trim();
                    if data.is_empty() {
                        return Ok(true);
                    }

                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                            for part in parts {
                                if let Some(text) = part["text"].as_str() {
                                    if !text.is_empty() {
                                        if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                                            finished = true;
                                            return Ok(false);
                                        }
                                    }
                                }
                                if part["functionCall"].is_object() {
                                    google_seq += 1;
                                    let name = part["functionCall"]["name"]
                                        .as_str()
                                        .unwrap_or("unknown_tool")
                                        .to_string();
                                    let args = if part["functionCall"]["args"].is_null() {
                                        serde_json::json!({})
                                    } else {
                                        part["functionCall"]["args"].clone()
                                    };
                                    let _ = on_event.send(StreamEvent::ToolCall {
                                        call_id: format!("call_{google_seq}"),
                                        name,
                                        arguments: serde_json::to_string(&args)
                                            .unwrap_or_else(|_| "{}".into()),
                                    });
                                }
                            }
                        }
                    }
                    Ok(true)
                })?;
                if finished {
                    return Ok(());
                }
            }
            _ = cancel.wait() => { return Err("cancelled".into()); }
        }
    }

    let _ = on_event.send(StreamEvent::Done { usage: None });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_tool_call_fragments_assemble_by_index() {
        let mut calls: BTreeMap<u64, ToolAcc> = BTreeMap::new();
        let mk = |index: u64, id: &str, name: &str, args: &str| {
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": index, "id": id,
                    "function": { "name": name, "arguments": args }
                }] } }]
            })
        };
        collect_openai_tool_delta(&mk(0, "call_a", "workspace_read", "{\"pa"), &mut calls);
        collect_openai_tool_delta(&mk(1, "call_b", "workspace_list", "{}"), &mut calls);
        // Later fragment for index 0: no id/name, arguments keep appending.
        collect_openai_tool_delta(&mk(0, "", "", "th\": \"x\"}"), &mut calls);

        assert_eq!(calls.len(), 2, "two distinct call indexes");
        let first = &calls[&0];
        assert_eq!(first.id.as_deref(), Some("call_a"));
        assert_eq!(first.name.as_deref(), Some("workspace_read"));
        assert_eq!(first.arguments, "{\"path\": \"x\"}");
        let second = &calls[&1];
        assert_eq!(second.id.as_deref(), Some("call_b"));
        assert_eq!(second.arguments, "{}");
    }

    /// The webview's `StreamEvent` type reads `event.callId` on tool calls;
    /// if this ever ships snake_case again, tool_exec rejects every call with
    /// "missing required key callId".
    #[test]
    fn tool_call_event_serializes_camel_case_fields() {
        let value = serde_json::to_value(StreamEvent::ToolCall {
            call_id: "call_a".into(),
            name: "workspace_list".into(),
            arguments: "{}".into(),
        })
        .expect("ToolCall serializes");
        assert_eq!(value["type"], "toolCall");
        assert_eq!(value["callId"], "call_a");
        assert!(value.get("call_id").is_none(), "no snake_case leak");
    }

    #[test]
    fn google_history_maps_assistant_to_model_and_tool_to_user() {
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: "list files".into(),
                tool_calls: Vec::new(),
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: "assistant".into(),
                content: "".into(),
                tool_calls: vec![ToolCall {
                    id: "call_1".into(),
                    name: "workspace_list".into(),
                    arguments: "{}".into(),
                }],
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: "{\"files\":[\"a\"]}".into(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_1".into()),
                name: Some("workspace_list".into()),
            },
        ];

        let contents = google_contents(&messages);
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(
            contents[1]["parts"][0]["functionCall"]["name"],
            "workspace_list"
        );
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(
            contents[2]["parts"][0]["functionResponse"]["name"],
            "workspace_list"
        );
    }

    #[test]
    fn anthropic_history_merges_consecutive_tool_results() {
        let messages = vec![
            ChatMessage {
                role: "tool".into(),
                content: "{\"a\":1}".into(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_1".into()),
                name: Some("workspace_read".into()),
            },
            ChatMessage {
                role: "tool".into(),
                content: "{\"b\":2}".into(),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_2".into()),
                name: Some("workspace_read".into()),
            },
        ];

        let out = anthropic_messages(&messages);
        assert_eq!(out.len(), 1, "results must ride in ONE user message");
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"].as_array().map(|a| a.len()), Some(2));
        assert_eq!(out[0]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(out[0]["content"][1]["tool_use_id"], "call_2");
    }

    #[test]
    fn openai_history_nulls_empty_content_with_tool_calls() {
        let messages = vec![ChatMessage {
            role: "assistant".into(),
            content: "".into(),
            tool_calls: vec![ToolCall {
                id: "call_9".into(),
                name: "workspace_list".into(),
                arguments: "{}".into(),
            }],
            tool_call_id: None,
            name: None,
        }];

        let out = openai_history(&None, &messages);
        assert_eq!(out[0]["tool_calls"][0]["id"], "call_9");
        assert_eq!(out[0]["tool_calls"][0]["function"]["name"], "workspace_list");
        assert_eq!(out[0]["content"], serde_json::Value::Null);
    }

    #[test]
    fn gemini_schemas_drop_additional_properties() {
        let schema = serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string", "additionalProperties": false }
            }
        });
        let stripped = strip_additional_properties(&schema);
        assert!(stripped.get("additionalProperties").is_none());
        assert!(stripped["properties"]["path"]
            .get("additionalProperties")
            .is_none());
        assert_eq!(stripped["properties"]["path"]["type"], "string");
    }

    #[test]
    fn cancel_signal_flags_without_waiters() {
        let signal = Arc::new(CancelSignal::new());
        assert!(!signal.cancelled.load(Ordering::Acquire));
        signal.trigger();
        assert!(signal.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn drain_lines_decodes_split_multibyte_chars() {
        // A chunk boundary lands inside the 2-byte 'é' sequence. Decoding
        // whole lines must reconstruct it; per-chunk lossy decode would
        // produce two U+FFFD replacement characters.
        let payload = "data: {\"content\":\"héllo wörld — ok\"}\ndata: {\"content\":\"second\"}\n";
        let bytes = payload.as_bytes();
        let split_inside_e = payload.find("é").unwrap() + 1;

        let mut buffer: Vec<u8> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        let mut collect = |line: &str| -> Result<bool, String> {
            lines.push(line.to_string());
            Ok(true)
        };

        buffer.extend_from_slice(&bytes[..split_inside_e]);
        assert!(drain_lines(&mut buffer, &mut collect).unwrap());
        buffer.extend_from_slice(&bytes[split_inside_e..]);
        assert!(drain_lines(&mut buffer, &mut collect).unwrap());
        assert!(buffer.is_empty(), "whole lines are consumed");

        assert_eq!(lines.len(), 2);
        assert!(!lines[0].contains('\u{FFFD}'), "no mojibake: {}", lines[0]);
        assert!(lines[0].contains("héllo wörld — ok"));
        assert!(lines[1].contains("second"));
    }

    #[test]
    fn drain_lines_stops_when_the_handler_finishes() {
        let mut buffer: Vec<u8> = b"one\ntwo\nthree\n".to_vec();
        let mut seen: Vec<String> = Vec::new();
        let stop = |line: &str| -> Result<bool, String> {
            seen.push(line.to_string());
            Ok(seen.len() < 2)
        };
        assert!(!drain_lines(&mut buffer, stop).unwrap(), "handler said stop");
        assert_eq!(seen, ["one", "two"]);
        // 'three' stays buffered for the next pump.
        let mut rest: Vec<String> = Vec::new();
        let mut collect = |line: &str| -> Result<bool, String> {
            rest.push(line.to_string());
            Ok(true)
        };
        assert!(drain_lines(&mut buffer, &mut collect).unwrap());
        assert_eq!(rest, ["three"]);
    }

    #[test]
    fn drain_lines_trims_crlf() {
        let mut buffer: Vec<u8> = b"data: {\"a\":1}\r\n\r\n".to_vec();
        let mut lines: Vec<String> = Vec::new();
        let mut collect = |line: &str| -> Result<bool, String> {
            lines.push(line.to_string());
            Ok(true)
        };
        assert!(drain_lines(&mut buffer, &mut collect).unwrap());
        assert_eq!(lines, ["data: {\"a\":1}", ""]);
    }

    #[test]
    fn a_fresh_cancel_is_remembered_and_the_list_stays_bounded() {
        // Its own list: the shared one belongs to whichever test is running.
        let mut cancelled = CancelledStreams::default();
        for i in 0..600 {
            cancelled.remember(&format!("stream-{i}"));
        }
        assert!(cancelled.contains("stream-599"));
        assert!(cancelled.contains(&format!("stream-{}", 600 - CANCELLED_MEMORY)));
        assert!(!cancelled.contains(&format!("stream-{}", 599 - CANCELLED_MEMORY)));

        // Remembering the same id twice does not evict a neighbour.
        cancelled.remember("stream-599");
        assert!(cancelled.contains(&format!("stream-{}", 600 - CANCELLED_MEMORY)));
    }
}
