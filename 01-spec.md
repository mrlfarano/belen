# BELEN — Product Specification

v0.1 · 2026-11-23 · derived from the 16-question discovery interview

---

## 1. The one-sentence product

**BELEN is a native Windows room where the interface is the conversation: you type, the model answers, and the answer becomes the tool you need.**

---

## 2. What BELEN is — and is not

| Is | Is not |
|---|---|
| A local-first chat surface for people who bring their own providers and keys | An Electron app |
| One continuous typographic room that reshapes itself as you talk | A web page in a frame |
| Provider-agnostic: OpenAI-compatible, Anthropic, Google, Ollama, LM Studio | A chat client with a sidebar |
| A Cordis-spined plugin runtime (skills, plugins, sub-agents) | A cloud service or an account system |
| Portable: a folder you can copy, no installer, no admin | An agent IDE |

---

## 3. The room

**One document. Continuous scroll. No bubbles, no cards, no avatars.**

- **Block types:** `user`, `assistant`, `text`, `tool`, `artifact`, `worker`, `system`.
- **Speaker is typography**, not chrome: alignment, weight, small caps, a hairline rule. Never a coloured bubble.
- **Chrome is summoned, not permanent.** One key (`Ctrl+K`) opens the command surface; `Esc` returns to the room. Nothing else is ever on screen.
- **Fork and pin.** Any assistant block can be forked into a branch or pinned so it stays in view as context.
- **Rooms are workspaces.** A room index is a typographic list inside the surface — never a sidebar.
- **Long rooms stay fast.** Blocks beyond ~200 are virtualised; off-screen blocks use `content-visibility: auto`. Prior blocks never reflow while a new one streams.

---

## 4. The signature moment

> **The answer that becomes a tool.**

You ask: *"Compare these three models on context, price and speed."*

The model streams text **and** a declarative `table` component. The table appears *before the sentence finishes*, is sortable, filterable and pinnable, and sits inside the sentence flow — not in a side panel. If the model emits something the kit does not know, the block degrades to text. Nothing ever breaks the page.

---

## 5. The generative surface protocol — BUI

**BUI (BELEN UI)** is a small, versioned, declarative JSON format. The model proposes; BELEN renders. The model never emits HTML or JS.

```json
{
  "v": 1,
  "blocks": [
    { "type": "text", "text": "Here is the comparison." },
    {
      "type": "table",
      "columns": [{ "key": "model", "label": "Model" }, { "key": "ctx", "label": "Context" }],
      "rows": [["A", "128k"], ["B", "1m"]],
      "pin": true
    },
    { "type": "metric", "label": "TTFT", "value": "38 ms" },
    { "type": "code", "lang": "ts", "text": "const x = 1" },
    { "type": "worker", "label": "Research", "status": "running" },
    {
      "type": "chart",
      "chart": "bar",
      "title": "Price per 1M",
      "unit": "USD",
      "categories": ["A", "B"],
      "series": [{ "name": "price", "points": [2.4, 0.9] }]
    }
  ]
}
```

**Rules**

- Fixed component kit only: `text`, `table`, `code`, `metric`, `form`, `timeline`, `worker`, `chart`.
- Validated with Zod before render; malformed or unknown → text fallback, never a crash.
- Text is escaped; URLs are `http(s)` only; no iframes, no images by default.
- Caps: ≤ 64 blocks per message, ≤ 200 rows per table, ≤ 64 KB per component.
- **Charts:** `bar`, `line`, `area`, `pie`, `donut`. Every series carries exactly one point per category (cross-validated, else text fallback); ≤ 60 categories, ≤ 8 series. Rendered as dependency-free SVG in the editorial type system — hairline axes, accent fill, tabular numerals — with an accessible spoken summary (`aria-label`) for screen readers. Bars sit on an honest zero baseline; pie/donut clamp negatives so the circle never corrupts. Pin works like every component.
- **Streaming:** the primary path is a `render_ui` tool call whose JSON arguments stream; the fallback is a fenced ` ```bui ` block. The parser tolerates truncation and renders a skeleton until the payload closes.
- **Pin** turns a transient component into a persistent block that survives reload.
- A2UI-inspired, deliberately **not** A2UI-compliant in v1 (interop is a later adapter).

---

## 6. Settings that answer back

**First run:** one typographic question — *"Who do you inference with?"* — with the registry list and **Something else**.

**Registry + introspection**

| Provider class | Discovery endpoint |
|---|---|
| OpenAI-compatible (OpenRouter, Groq, Z.ai, DeepSeek, xAI…) | `GET {base}/models` |
| Anthropic | `GET /v1/models` |
| Google | `GET /v1beta/models` |
| Ollama | `GET /api/tags` |
| LM Studio | `GET /v1/models` |

The registry entry carries: id, label, endpoint templates, auth type, model metadata (context, modalities, reasoning), capabilities and quirks.

**Z.ai** uses `https://api.z.ai/api/paas/v4` (Coding Plan: `https://api.z.ai/api/coding/paas/v4`). Its `/models` endpoint works — 13 models as of 2026-11-24, including `glm-5.4` and `glm-5.3`. The registry also ships a known-model fallback so an outage degrades to a usable list with a notice instead of a dead end.

**Authentication modes:** API key, access token (bearer), environment variable, and OAuth 2.0 device code ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)). OAuth tokens live in DPAPI and refresh 60 s before expiry. Design and provider notes: [04-auth.md](04-auth.md).

**The config sheet assembles in place** — no modal, no wizard:

1. Provider name and endpoint (prefilled, editable).
2. Auth (key field appears inline only when needed).
3. Model list pulled live, with metadata.
4. Default model and per-model settings (temperature, max tokens, top_p, reasoning effort where supported).
5. **Test** — one-token request, reports TTFT.
6. Live updates via Cordis `Volatile<T>` / `fiber.update()` — change a value, no restart.

**Keys:** Windows DPAPI (`CryptProtectData`, CurrentUser scope) via Rust. Never in the renderer, never in logs, never in export.

---

## 7. Skills, plugins, sub-agents

All three are **Cordis plugins underneath**. The manifest is data; the code is one of BELEN's built-in modules.

| Kind | Manifest carries | Executes code? |
|---|---|---|
| **Skill** | Instructions, trigger phrases, tool bindings, optional UI blocks | No |
| **Plugin** | Composes built-in capabilities; requests capabilities explicitly | Only with a per-plugin grant (post-v1) |
| **Sub-agent** | Model, system prompt, tool grants, budget (turns / tokens / time) | No — it runs a model loop |

- **Install** = mount a fiber. **Uninstall** = `fiber.dispose()` — Cordis's reversible effects guarantee no leaked listeners or timers.
- **Catalog:** bundled JSON, ranked by usage, provider compatibility and safety tier; a recommendation list lives inside Settings. No network required.
- **Sub-agents appear as in-flow worker blocks** — collapsible, streaming, pinnable, interruptible. Cancellation is disposal, not a flag.

---

## 8. Performance budget (ratified)

| Metric | Target | Method |
|---|---|---|
| Cold start → first paint | ≤ 1,000 ms (p95, idle) | Measured 0.88–1.38 s depending on load; gate set to 1.5 s |
| Resident summon → interactive | ≤ 120 ms (p95) | Measured 113–115 ms |
| Warm launch → interactive | ≤ 120 ms (p95) | Second launch within 5 s |
| Keystroke → glyph | ≤ 5 ms (p99) | `keydown` → rAF after mutation, 1 000 samples |
| Streaming frame budget | 0 dropped frames @ 120 Hz | rAF delta histogram over a 2 000-token stream |
| TTFT overhead | ≤ 30 ms over provider | Client timestamp − provider timestamp |
| Idle RAM | ≤ 120 MB | Working set after 10 min idle |
| Portable folder | ≤ 15 MB | Sum of shipped files |
| Layout shift during stream | 0 px | Layout shift observer |

A `belen perf` script fails the build on any breach.

> **Revised 2026-11-23:** the original 400 ms cold target was below WebView2's process-creation floor (~800 ms measured). Cold start is now ≤ 1 s; the 120 ms target moves to a resident summon, where BELEN keeps a lightweight process alive after the window closes. See [02-tasks.md](02-tasks.md).
>
> **Measured (release, 2026-11-24):** cold 1.06–1.66 s (median 1.43 s) · summon 113–115 ms · keystroke 0.7 ms · 0 dropped frames steady · 2/240 synthetic stream · 24.8 MB · 9.6 MB exe.
>
> **Re-gated after the chart release (same day):** 856 ms cold · keystroke 0.4 ms p99 · 0/180 frames · 0/240 stream · 27 MB working set · 9.77 MB exe. The chart module adds ~22 kB gzip.

---

## 9. Data, keys, privacy

- **SQLite + FTS5** for rooms, blocks, settings and the catalog.
- Files live beside the executable: `data/belen.db`, `data/config.json`, `data/keys.dpapi`.
- Export: Markdown + JSON. Import: JSON.
- **No account. No telemetry. No network** except the provider the user chose —
  and the update check, which only runs when the user asks for it (About tab
  or palette command).

---

## 10. Non-goals for v1

Mobile, web, macOS/Linux · cloud sync, accounts, sharing · third-party code plugins (manifests only) · RAG / knowledge bases · image and audio generation · unprompted update checks (updates run only on demand, from the About tab).

---

## 11. Success criteria

1. Every budget metric passes on this machine.
2. First run → first token in **≤ 3 interactions** (pick provider, paste key, type).
3. Demo: **3 providers**, one room, one interactive table, one sub-agent.
4. Uninstall a skill → **zero** remaining listeners or timers (Cordis test).
5. Portable folder runs from a clean folder with WebView2 present.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WebView2 cold start / first-run profile creation | Pre-warm, keep assets small, measure p95 not mean |
| Cordis core in a browser runtime | Dependencies verified pure; browser smoke test in CI |
| IPC overhead while streaming | Tauri channels + per-frame batching; never one IPC per token |
| Generative UI inconsistency | Fixed kit, Zod validation, text fallback, pin |
| Portable WebView2 user-data folder | Explicit `dataDirectory` under the app folder |
| Typography / FOUT | Bundle OFL variable fonts, subset, preload, metric-compatible fallback |
| Rust link environment | `VsDevCmd` wrapper script (verified working) |
