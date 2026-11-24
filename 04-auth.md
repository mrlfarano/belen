# BELEN — Authentication beyond API keys

v0.1 · 2026-11-24 · status: device flow implemented, PKCE/Azure next

---

## 1. The constraint

BELEN is a local-first desktop app with **no backend**. Any auth flow must work from a
single Windows binary, must not ship a client secret, and must store tokens encrypted
at rest. That rules out several “just add OAuth” shortcuts.

---

## 2. Options considered

| Method | UX | Provider support | Effort | Notes |
|---|---|---|---|---|
| **API key** (current) | Paste once | Universal | Done | Simple, long-lived, revocable |
| **OAuth 2.0 device grant** (RFC 8628) | Show code + URL; user approves on phone/PC | Entra, GitHub, Google limited-input, custom IdPs | **Implemented** | No localhost listener; works from any desktop binary |
| **Auth code + PKCE, loopback redirect** (RFC 8252) | Click → system browser → return | Any browser IdP | Medium | Best UX for consumer IdPs; needs client registration and a localhost listener |
| **Access token paste** | Paste a short-lived token | `gcloud auth print-access-token`, `az account get-access-token`, gateways | **Implemented** | Zero integration; expires; good fallback |
| **Environment variable / ADC** | Set once in the shell | OpenAI, Anthropic, Google, cloud CLIs | **Implemented** | No secret on disk; ideal for dev machines |
| **Custom header** | Name + value | Azure (`api-key`), enterprise gateways | Implemented (Rust) | Not surfaced in the UI yet |
| **Gateway** (LiteLLM, OpenRouter) | One local base URL | Anything the gateway supports | Config only | Centralises auth and routing |
| **Consumer subscription tokens** (ChatGPT, Claude, Copilot) | “Sign in with your subscription” | First-party clients only | **Rejected** | Against provider terms, brittle, and turns BELEN into a credential thief |

### Rejected: subscription-token extraction

Reading ChatGPT/Claude/Copilot session tokens out of official apps or browser storage is
not a supported integration. It breaks on every client update, violates terms, and puts
the user's account at risk. BELEN will not do it.

---

## 3. What BELEN implements

### 3.1 OAuth 2.0 device grant (generic)

1. `POST {deviceEndpoint}` with `client_id` (+ optional `scope`) in
   `application/x-www-form-urlencoded`.
2. Show `user_code` and `verification_uri` (or `verification_uri_complete`).
3. Poll `{tokenEndpoint}` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`.
4. Handle `authorization_pending`, `slow_down`, `expired_token`, `access_denied`.
5. Store `access_token` + `refresh_token` + `expires_at` with DPAPI; refresh 60 s before expiry.

This is the flow defined by [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) and
documented for Entra in
[Microsoft's device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).

### 3.2 Access token mode

Paste a bearer token produced by a CLI (`gcloud`, `az`) or a gateway. Same header path as
an API key, but labelled as short-lived and not assumed to be permanent.

### 3.3 Environment variable mode

The renderer stores only the *name* (e.g. `OPENAI_API_KEY`); Rust reads the value at
request time. Nothing secret is written to disk or exposed to the webview.

### 3.4 Custom header (Rust layer)

`auth: "header"` + `headerName` + value supports `api-key`-style providers (Azure) and
enterprise gateways. UI exposure comes with the Azure adapter.

---

## 4. Token lifecycle

- Access + refresh tokens live in `data/keys/provider:<id>:oauth.dpapi` (DPAPI,
  current-user scope). They never enter the renderer's long-term state.
- `resolveSpec()` refreshes when `expires_at - 60 s` has passed and a refresh token exists.
- A failed refresh surfaces as a normal provider error: “OAuth token expired — reconnect”.
- Sign-out clears the DPAPI entry.

---

## 5. Provider notes

| Provider | Works today | Notes |
|---|---|---|
| **Microsoft Entra / Azure OpenAI** | Device flow | Device endpoint `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`; token `.../token`; scope `https://cognitiveservices.azure.com/.default offline_access`. Azure's deployment path and `api-version` need a dedicated adapter — next step. |
| **Google / Vertex** | Access token / ADC | Vertex uses OAuth service accounts or ADC; the Gemini API key path remains the simple option. |
| **GitHub** | Device flow | Available for GitHub APIs. Copilot inference in third-party clients remains terms-constrained; not implemented. |
| **OpenAI / Anthropic / Z.ai** | API key | No public third-party inference OAuth. |
| **Ollama / LM Studio** | None | Local, no auth. |

---

## 6. Security rules

1. No client secrets in the binary — public clients only.
2. PKCE (`S256`) if the loopback flow is added.
3. DPAPI current-user scope; tokens never logged, never rendered.
4. Request the narrowest scope; `offline_access` only when refresh is needed.
5. Refresh before expiry; clear on sign-out; surface failures as provider errors.

---

## 7. Recommendation

Ship the device grant + access-token + environment modes now (done). Next, in order:

1. **PKCE loopback** for IdPs that prefer a browser redirect.
2. **Azure OpenAI adapter** (deployment path + `api-version` + Entra token).
3. **Vertex ADC** (service-account JSON and `gcloud` ADC).
4. Provider-specific OAuth only where the provider documents third-party clients.

References: [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) ·
[RFC 8252 (native apps)](https://datatracker.ietf.org/doc/html/rfc8252) ·
[Microsoft device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
