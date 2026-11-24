# BELEN — Discovery Brief

v0.1 · 2026-11-23 · status: **Phase 0 built** (T01–T05 complete)

---

## 0. The brief, as received

- BELEN = a chat interface between an end-user and an inference provider.
- Clean, sleek, simple, very user-friendly. Performance is non-negotiable: **ULTRA FAST**.
- **Settings**: system asks which provider you have → auto-pulls the provider's necessary configuration (name, models, model settings, endpoints, etc.). Must also let the user create/install skills, plugins and sub-agents, with recommendation lists.
- **Interface**: must not look like anything shipping today. Must *evolve with what the user says* — from Settings all the way to the chat surface. Built on something like **Cordis**.
- **Bar**: wows every AI user, and every person who has ever worked with an interface, OS or device.
- **Process**: interview before building. One question at a time. Then name the tools, using the current OS, its built-in tooling and programming languages.

---

## 1. What already exists — and what "new" must therefore mean

| Product | What it is | What it proves | What it leaves open |
|---|---|---|---|
| ChatGPT / Claude desktop | Polished first-party chat | Chat chrome is a solved, saturated pattern | The surface is static; one shape for every intent |
| Cherry Studio 2.0 | AGPL desktop client rebuilt around agents, MCP tools, knowledge bases, Ollama | Provider switching + agents is now table stakes | Still a sidebar-and-bubbles app |
| Jan | Local-first, private, minimal | Minimalism has an audience | Minimal ≠ new |
| LM Studio | Desktop power-user local inference | Local models are mainstream | Closed source; utilitarian UI |
| Open WebUI | Self-hosted platform layer | Teams want a "platform" | Web-app feel; not an OS-like object |
| Warp / Raycast / Zed | Native-speed launch surfaces | Sub-100ms surfaces change how a tool *feels* | Not conversation-native |

**Takeaway:** the market is saturated with *chat clients*. Nobody owns **the interface as a living object**. The novelty budget must be spent on the surface and its physics — not on adding features that already exist.

---

## 2. Cordis — what it buys, what it costs

Source: [Understanding Cordis (dev.to, Sep 2026)](https://dev.to/worldlinetech/understanding-cordis-the-typescript-framework-built-for-hot-swapping-everything-1ihb) · [@deepseek-ai/cordis on npm](https://www.npmjs.com/package/@deepseek-ai/cordis)

- MIT TypeScript **meta-framework**. Core primitives: `Context` tree, `Fiber` (`PENDING` → `ACTIVE` → `DISPOSED`), `Service` via declaration merging, reversible `ctx.effect()`, `bail` / `waterfall` events.
- Official packages: `cordis` (core), `create-cordis`, `@cordisjs/plugin-loader`, `plugin-include` (YAML/JSON config), `plugin-group`, `plugin-hmr`, `plugin-logger-console`, `plugin-timer`.
- Current: **v4.0.5**, ESM-first, Node 22+ for the scaffolder. Battle-tested via Koishi; the engine under DeepSeek Harness.

**Buys you**
- Install / update / uninstall a skill, plugin or sub-agent **at runtime, no restart** — this *is* the "install skills" requirement.
- Config changes without restart; `Volatile<T>` lets the loader commit live changes into running references.
- Guaranteed teardown (no leaked listeners/timers) — which is also a **performance** feature over long sessions.

**Costs you**
- Loader and HMR are Node-side. A webview-only shell must either bundle core-only or run a Node sidecar.
- ESM-only toolchain; plugin authors must respect `inject` and effects.

---

## 3. "Ultra fast" as numbers — proposed budget (to be ratified)

| Metric | Target | Why |
|---|---|---|
| Cold start → first paint | ≤ 400 ms | Under the "instant" threshold |
| Warm launch → interactive | ≤ 120 ms | Feels resident, not launched |
| Keystroke → glyph | ≤ 5 ms | Typing must never lag |
| Frame budget while streaming | < 8.3 ms @ 120 Hz | No jank at high refresh |
| TTFT overhead over provider | ≤ 30 ms | BELEN must not be the slow part |
| Idle RAM | ≤ 120 MB | Stay out of the user's way |
| Installer | ≤ 15 MB | Download in seconds |
| Layout shift during stream | 0 px | Text must never jump |

Reference points: the ~100 ms "instant" rule ([Kinetic Edge](https://kineticedge.io/insights/latency-budgets-for-ai-features)); 60 Hz = 16.7 ms/frame, 120 Hz = 8.3 ms/frame.

---

## 4. "Interface that evolves" — state of the art

- **A2UI 1.0** (stable Nov 2026): Google's framework-agnostic open standard where the agent emits a **declarative JSON UI description** and the client renders it. Safety by construction — no arbitrary HTML/JS from the model. [a2ui.org](https://a2ui.org/) · [Google announcement](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces)
- **Generative Interfaces** (arXiv 2508.19227): goal-driven, adaptive UI generated per interaction.
- **The tension to design around:** evolution vs. predictability vs. latency vs. safety. Every generative surface needs (a) a deterministic fallback and (b) a "pin this" affordance so the user can freeze a layout they like.

---

## 5. Four candidate theses for BELEN

### A. ONE SURFACE — the invisible shell
The app chrome disappears. Full-screen, no sidebar, no bubbles: one continuous room where your words, the model's words, artifacts, sliders and provider settings appear **in place** as the conversation needs them. Chrome is summoned by a single key. Settings are conversational — say "I'm on OpenRouter" and it introspects `/v1/models` and lays out a live config sheet inline, no modal.
**Wow:** the UI *is* the conversation. **Risk:** discoverability; rendering a long evolving document at 120 fps. **Cost:** high design, medium engineering.

### B. ZERO-LATENCY PALETTE — the speed object
A tiny native-feeling window that opens in under 80 ms, keystroke-to-glyph under 5 ms, streams at full token rate with zero layout shift. Keyboard-first, one input line, results as a stack.
**Wow:** felt, not seen — it behaves like an instrument. **Risk:** visually less novel. **Cost:** low.

### C. THE LIVING CANVAS — conversation as a workspace
Every turn is an object on an infinite canvas. Branches, forks, sub-agents, files and charts are nodes you drag, pin and connect. The interface literally grows with what you say.
**Wow:** your chat history becomes a spatial memory palace. **Risk:** canvas performance; no mobile; learning curve. **Cost:** high.

### D. THE OPERATOR — agent desktop
A local control room: provider config is a power strip, skills/plugins are cartridges, sub-agents are workers with their own panes. Chat is the command line of your computer.
**Wow:** the first chat app that feels like an OS for agents. **Risk:** scope explosion. **Cost:** very high.

---

## 6. Interview log

_(appended after each answer)_

---

**Q1 — Which BELEN do you want to exist?** → **A · ONE SURFACE** (the invisible shell). Chrome disappears; settings and chat become one continuous room that reshapes as you talk. Locked as the product thesis.

---

**Q2 — First non-negotiable user?** → **Me — power-user daily driver.** Bring-your-own keys, own providers, optimise for daily delight; distribution model deferred.

---

**Q3 — Where does it live?** → **Native Windows app, full-screen-first.** Real window, full-screen-capable, native feel; global summon is a later layer, not v1.

---

**Q4 — Primary evolution mechanism?** → **A · Model-proposed, system-rendered.** The model emits a declarative UI description (A2UI-style) drawn from a fixed typed component kit; the client renders it; plain text is always a valid fallback. Novelty is real, but the renderer and schema stay ours.

---

**Q5 — Signature moment on day one?** → **The answer that becomes a tool.** A comparison request returns an interactive table (sort/filter/pin) inside the sentence flow. This is the demo that proves 'the interface is the answer'.

---

**Q6 — Speed envelope?** → **Proposed budget ratified:** cold start ≤400 ms, warm launch ≤120 ms, keystroke→glyph ≤5 ms, streaming at 120 Hz (<8.3 ms frames), TTFT overhead ≤30 ms, idle RAM ≤120 MB, installer ≤15 MB, zero layout shift.

---

**Q7 — Provider discovery?** → **A · Registry + introspection.** Built-in provider catalog (endpoint templates, model metadata, quirks) plus a custom base-URL path that introspects `/v1/models`; the config sheet is assembled from real discovery.

---

**Q8 — How much power does an installed thing get?** → **A · Manifests by default.** Skills/plugins are declarative manifests composing built-in capabilities; executing code requires an explicit per-plugin grant. Cordis remains the runtime, but the default install is data, not code.

---

**Q9 — Sub-agents in the surface?** → **A · In-flow worker blocks.** Delegation runs inside the same room as a collapsible, streaming 'worker' block; expand, pin or interrupt without leaving the surface.

---

**Q10 — Where do data and keys live?** → **A · Local-only, zero telemetry.** SQLite + FTS on disk; no account, no telemetry; network only to the chosen provider. Export/import as plain files.

---

**Q11 — Visual language?** → **A · Editorial / typographic.** No bubbles, no cards; the page reads like a living document. Strong type, generous measure, ink-on-paper or true black.

---

**Q12 — What is 'cordis'?** → **A · Cordis v4 is the spine.** BELEN is a set of Cordis plugins around a tiny kernel: Context tree, Fibers, Services, reversible effects, hot-swap loader.

---

**Q13 — Conversation model?** → **A · Rooms as living documents.** A room is a workspace: one continuous document you scroll, with branches you fork and pin. History is spatial, not a list of chats.

---

**Q14 — Who builds it?** → **A · AutoClaw builds, user directs.** Code is written and run in this workspace; the plan becomes an executable task list.

---

**Q15 — Time to 'wow'?** → **A · Six weeks — a daily driver.** One provider path, the living-room surface, one interactive component family, manifest-based skills/sub-agents, and a performance harness.

---

**Q16 — Guardrails for v1?** → **No Electron · Portable, no installer · Offline-first local models.** (Open source and keyboard-only were not selected as hard law.)

---

## 7. Decisions locked

| # | Decision |
|---|---|
| 1 | **Thesis: ONE SURFACE** — the interface is the product |
| 2 | **First user: me** — power-user daily driver, own keys |
| 3 | **Native Windows app, full-screen-first** |
| 4 | **Evolution: model-proposed, system-rendered** (declarative BUI) |
| 5 | **Signature moment: the answer that becomes a tool** |
| 6 | **Speed budget ratified** (400 ms cold / 120 ms warm / 5 ms keystroke / 120 Hz) |
| 7 | **Providers: registry + introspection** |
| 8 | **Install trust: manifests by default** |
| 9 | **Sub-agents: in-flow worker blocks** |
| 10 | **Data: local-only, zero telemetry** |
| 11 | **Visual language: editorial / typographic** |
| 12 | **Cordis v4 is the spine** |
| 13 | **Conversation model: rooms as living documents** |
| 14 | **Builder: AutoClaw builds, user directs** |
| 15 | **Horizon: six weeks to a daily driver** |
| 16 | **Guardrails: no Electron · portable · offline-first** |
| 17 | **Budget revised:** cold ≤ 1 s, resident summon ≤ 120 ms |

**Outputs:** [01-spec.md](01-spec.md) · [02-tasks.md](02-tasks.md) · [03-toolchain.md](03-toolchain.md)

- **Thesis: ONE SURFACE.** The interface is the product; novelty is spent on the surface and its physics, not on feature count.

_(none yet)_
