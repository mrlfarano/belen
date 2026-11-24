use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

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
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Token { text: String },
    Done { usage: Option<serde_json::Value> },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
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
        "contents": messages.iter().map(|m| serde_json::json!({
            "role": m.role,
            "parts": [{ "text": m.content }]
        })).collect::<Vec<_>>(),
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

pub async fn stream(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    match spec.kind.as_str() {
        "anthropic" => stream_anthropic(spec, model, system, messages, on_event).await,
        "google" => stream_google(spec, model, system, messages, on_event).await,
        _ => stream_openai(spec, model, system, messages, on_event).await,
    }
}

async fn stream_openai(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", base(&spec));
    let mut history: Vec<serde_json::Value> = Vec::new();
    if let Some(s) = &system {
        history.push(serde_json::json!({ "role": "system", "content": s }));
    }
    for m in &messages {
        history.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    let body = serde_json::json!({ "model": model, "messages": history, "stream": true });
    let response = apply_auth(client()?.post(&url).json(&body), &spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(idx) = buffer.find('\n') {
            let line = buffer[..idx].trim_end_matches('\r').to_string();
            buffer.drain(..=idx);

            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                let _ = on_event.send(StreamEvent::Done { usage: None });
                return Ok(());
            }

            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
                    if !text.is_empty() {
                        if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    let _ = on_event.send(StreamEvent::Done { usage: None });
    Ok(())
}

async fn stream_anthropic(
    spec: ProviderSpec,
    model: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/v1/messages", base(&spec));
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "messages": messages,
        "stream": true,
    });
    if let Some(s) = system {
        body["system"] = serde_json::Value::String(s);
    }

    let response = apply_auth(client()?.post(&url).json(&body), &spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(idx) = buffer.find('\n') {
            let line = buffer[..idx].trim_end_matches('\r').to_string();
            buffer.drain(..=idx);

            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }

            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if value["type"] == "content_block_delta" {
                    if let Some(text) = value["delta"]["text"].as_str() {
                        if !text.is_empty() {
                            if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                                return Ok(());
                            }
                        }
                    }
                }
                if value["type"] == "message_stop" {
                    let _ = on_event.send(StreamEvent::Done { usage: None });
                    return Ok(());
                }
            }
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
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let url = format!("{}/models/{model}:streamGenerateContent?alt=sse", base(&spec));
    let mut body = serde_json::json!({
        "contents": messages.iter().map(|m| serde_json::json!({
            "role": m.role,
            "parts": [{ "text": m.content }]
        })).collect::<Vec<_>>(),
    });
    if let Some(s) = system {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": s }] });
    }

    let response = apply_auth(client()?.post(&url).json(&body), &spec)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {}", truncate(&text, 300)),
        });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(idx) = buffer.find('\n') {
            let line = buffer[..idx].trim_end_matches('\r').to_string();
            buffer.drain(..=idx);

            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }

            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = value["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                    if !text.is_empty() {
                        if on_event.send(StreamEvent::Token { text: text.into() }).is_err() {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    let _ = on_event.send(StreamEvent::Done { usage: None });
    Ok(())
}
