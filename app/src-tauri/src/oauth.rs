use std::time::Duration;

use serde::{Deserialize, Serialize};

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartRequest {
    pub device_endpoint: String,
    pub client_id: String,
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

pub async fn device_start(req: DeviceStartRequest) -> Result<DeviceStart, String> {
    let mut form: Vec<(&str, &str)> = vec![("client_id", req.client_id.as_str())];
    if !req.scope.trim().is_empty() {
        form.push(("scope", req.scope.as_str()));
    }

    let response = client()?
        .post(&req.device_endpoint)
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let device_code = json["device_code"]
        .as_str()
        .ok_or("device endpoint returned no device_code")?
        .to_string();
    let user_code = json["user_code"]
        .as_str()
        .ok_or("device endpoint returned no user_code")?
        .to_string();
    let verification_uri = json["verification_uri"]
        .as_str()
        .ok_or("device endpoint returned no verification_uri")?
        .to_string();

    Ok(DeviceStart {
        device_code,
        user_code,
        verification_uri,
        verification_uri_complete: json["verification_uri_complete"]
            .as_str()
            .map(|s| s.to_string()),
        expires_in: json["expires_in"].as_u64().unwrap_or(900),
        // RFC 8628: clients MUST default to 5 seconds when interval is absent.
        interval: json["interval"].as_u64().unwrap_or(5),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollRequest {
    pub token_endpoint: String,
    pub client_id: String,
    pub device_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSet {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    /// pending | slow_down | expired | denied | ok | error
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn parse_tokens(json: &serde_json::Value) -> Result<TokenSet, String> {
    let access_token = json["access_token"]
        .as_str()
        .ok_or("token endpoint returned no access_token")?
        .to_string();

    Ok(TokenSet {
        access_token,
        refresh_token: json["refresh_token"].as_str().map(|s| s.to_string()),
        expires_in: json["expires_in"].as_u64(),
        token_type: json["token_type"].as_str().map(|s| s.to_string()),
        scope: json["scope"].as_str().map(|s| s.to_string()),
    })
}

pub async fn poll(req: DevicePollRequest) -> Result<PollResult, String> {
    let response = client()?
        .post(&req.token_endpoint)
        .header("accept", "application/json")
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
            ("device_code", req.device_code.as_str()),
            ("client_id", req.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;

    if status.is_success() {
        let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        return Ok(PollResult {
            status: "ok".into(),
            tokens: Some(parse_tokens(&json)?),
            error: None,
        });
    }

    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
    let error = json["error"].as_str().unwrap_or("error").to_string();
    let mapped = match error.as_str() {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" | "authorization_declined" => "denied",
        _ => "error",
    };

    Ok(PollResult {
        status: mapped.into(),
        tokens: None,
        error: Some(
            json["error_description"]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("HTTP {status}: {error}")),
        ),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub token_endpoint: String,
    pub client_id: String,
    pub refresh_token: String,
}

pub async fn refresh(req: RefreshRequest) -> Result<TokenSet, String> {
    let response = client()?
        .post(&req.token_endpoint)
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", req.refresh_token.as_str()),
            ("client_id", req.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate(&body, 300)));
    }

    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    parse_tokens(&json)
}
