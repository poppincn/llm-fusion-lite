<div align="center">

# ⚡ Era Fusion

**Multi-model fusion with adaptive, learned model strengths.**

Dispatch one prompt to a panel of frontier models in parallel, then have an
influence-weighted judge synthesize a single best answer — and watch it learn
which model is the de-facto expert on each subject over time.

[![npm](https://img.shields.io/npm/v/@alexanderollman/llm-fusion?color=cb3837&logo=npm)](https://www.npmjs.com/package/@alexanderollman/llm-fusion)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![CI](https://github.com/Alexander-Ollman/llm-fusion/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexander-Ollman/llm-fusion/actions/workflows/ci.yml)

**Graphical chat UI · CLI · OpenAI-compatible endpoint · `/fuse` skill for agentic coding tools**

</div>

---

Inspired by [OpenRouter's "Fusion beats Frontier"](https://openrouter.ai/blog/announcements/fusion-beats-frontier/)
and the [`fusion-fable`](https://github.com/duolahypercho/fusion-fable) skill, with one big
addition: **it learns which model is the de-facto subject-matter expert over time** and
weights the synthesis accordingly.

Diversity is **harvested, not manufactured** — the same prompt to different models yields
different reasoning paths, tool calls, and sources. No synthetic personas.

## How it works

```
request
  │
  ├─▶ adjudicate ──────────  subject (category) + dynamic depth (light · standard · deep)
  │
  ├─▶ select panel ────────  N distinct models, chosen by learned per-subject strength
  │                          (ε-greedy exploration keeps trying under-used models)
  │
  ├─▶ dispatch in parallel  each model answers the SAME prompt independently
  │                          (depth scales tools: none → web search → agentic loop
  │                           with web search + web fetch + sandboxed code execution)
  │
  ├─▶ judge (2 phase) ─────  A) structured comparison: consensus · contradictions ·
  │                             gaps · unique insights · per-model INFLUENCE score,
  │                             informed by learned subject expertise as a soft prior
  │                          B) streamed final answer, grounded in the analysis
  │
  └─▶ learn ───────────────  influence scores accumulate into per-model, per-subject
                             expertise (SME) → feeds future panel selection + judging.
                             Optional 👍/👎 feedback refines it further.
```

## Quick start

```bash
npm install -g @alexanderollman/llm-fusion   # Node ≥ 22
fuse setup                                    # guided wizard: keys + defaults + /fuse skill
fuse "What's the best way to design an idempotent webhook consumer?"
```

Prefer to run from source?

```bash
git clone https://github.com/Alexander-Ollman/llm-fusion && cd llm-fusion
./scripts/install.sh     # installs deps, builds, puts `fuse`/`fuse-run` on PATH, installs the skill
fuse setup
fuse doctor              # verify environment
```

> Works out-of-the-box with **just an Anthropic key** (Opus 4.8 + Sonnet 4.6, judged by
> Opus 4.8). Add OpenAI / Google keys for true cross-provider fusion. Run
> `fuse doctor --probe` to confirm a model actually answers before relying on it.

### Configuring providers

`fuse setup` is the quickest path — a terminal wizard that, **per provider
(Anthropic / OpenAI / Google), lets you choose an auth mode**:

| Mode | What it does |
|---|---|
| **API key** | The provider's official SDK with a key (masked entry, written to `~/.era-fusion/.env`, mode `0600`). |
| **Subscription login** | Calls the provider's CLI (`claude` / `codex` / `gemini`) as a subprocess using your logged-in Pro/Max plan — **no API key**. The wizard installs/updates the CLI and prints the login command. |
| **Skip** | Leave that provider unconfigured. |

Both modes feed the full engine (panel selection, two-phase judge, adaptive learning).
Prefer env vars? `export ANTHROPIC_API_KEY=…` (at least one; OpenAI / Google optional).
Re-run `fuse setup` anytime to change a mode; `fuse setup --skill-only` just (re)installs
the skill.

> **Subscription-mode limits:** CLI panelists report no token usage, so cost shows
> **$0/unmetered**. CLIs are also less reliable at strict JSON — keep the judge on an
> api/Anthropic model when you can.

### Models & reasoning effort

The registry ships with **Claude Fable 5** (Anthropic's most capable) and **GPT-5.6
(Sol)** alongside the Opus / Sonnet / GPT-5.5 / Gemini panelists. Each model has an
editable **reasoning effort** (`low · medium · high · xhigh · max`, default `high`) in
the dashboard's **Setup → Models** pane. Effort maps to each provider's native control —
Anthropic `output_config.effort`, OpenAI `reasoning.effort` (`xhigh`/`max` clamp to
`high`); providers without an effort knob ignore it. Newer default model ids
(`claude-fable-5`, `gpt-5.6-sol`) may need a key with access — run `fuse doctor --probe`
to confirm one answers before relying on it.

### Custom OpenAI-compatible endpoints

Any endpoint that speaks the OpenAI Chat Completions API — a local Ollama /
vLLM server, OpenRouter / DeepSeek / Qwen, or a private enterprise gateway —
can join the panel as a model with `provider: "openai-compatible"`. Add it in
`~/.era-fusion/config.json` (or the dashboard's **Setup → Models** pane):

```jsonc
{
  "id": "llama-local",
  "provider": "openai-compatible",
  "model": "llama3.1",
  "label": "Llama (local)",
  "baseURL": "http://localhost:11434/v1",  // no trailing slash
  "apiKeyEnv": "OLLAMA_API_KEY",           // env var holding the key (default BASETEN_API_KEY)
  "apiKeyHeader": "Authorization",         // auth header (default → `Bearer <key>`)
  "headers": { "X-Title": "my-app" },      // optional extra HTTP headers
  "extraParams": { "temperature": 0.2 }    // optional request-body passthrough
}
```

- **Auth** — the key is sent as `Bearer <key>` in `Authorization` by default.
  Set `apiKeyHeader` to any other name (e.g. `api-key`) to send the raw key —
  the convention for private gateways. Set the env var via the dashboard's
  **Setup → Keys** "custom" row, or `~/.era-fusion/.env`.
- **Keyless local endpoints** (Ollama) — give the env var any non-empty value;
  local servers ignore the auth header.
- Add the model id to `autoPanel` to make it eligible for adaptive panel
  selection. `fuse doctor` lists custom endpoints and `fuse doctor --probe`
  live-checks them.
- Custom endpoints have no hosted web search, so depth tiers collapse to a
  single completion. `agentic` mode still works via the sandboxed
  function-calling loop.

## Surfaces

### CLI

```bash
fuse "explain CRDTs like I'm a backend engineer"
echo "summarize this" | fuse --quiet                       # pipe-friendly, answer-only on stdout
fuse --panel claude-opus-4-8,gpt-5.5,gemini-3-pro "compare these approaches"
fuse --depth deep "research the current state of X"        # force agentic deep panelists
fuse stats coding                                          # learned per-subject strengths
fuse feedback <run-id> up                                  # teach it which answers were good
```

Full command set: `serve`, `setup`, `stats`, `usage`, `feedback`, `doctor`, `config`, `models`.

### Web UI

```bash
fuse serve            # → http://localhost:8787  (chat · strengths · usage · setup)
```

Live panel view, streamed synthesis, an analysis panel, 👍/👎 feedback, and a
learned-strengths dashboard. Dev mode: `npm run dev:server && npm run dev:web` (Vite
proxies `/api` + `/v1`).

### As a model (OpenAI-compatible)

Point any OpenAI-compatible client (Claude Code / OpenCode / Cursor) at the server and
use the model id `fusion`:

```
base URL:  http://localhost:8787/v1
model:     fusion
```

Every request fans out to the panel and returns one synthesized answer. Non-standard body
fields `panel`, `judge`, `panel_size`, `web_search` are honored. Each call feeds the
adaptive store.

### As a skill in Claude Code / OpenCode

```
/fuse <your request>
```

…or just say *"run this through fusion."* The skill is **service-first with CLI fallback**:
with provider keys it runs the full engine (and learns); without keys — or if the engine
can't authenticate — it orchestrates the `claude` / `codex` / `gemini` CLIs directly, **in
parallel**, so fusion works even before any keys are set.

A **credential preflight** runs before any model call: fusion never dispatches to a provider
without usable credentials. Uncredentialed or unauthenticated models are skipped up front
with a clear reason (an explicit `--panel` is strict and stops if any selected model is
missing credentials); a blank request is rejected without spending inference. Check what's
ready with `fuse doctor` (add `--probe` to verify each CLI is actually logged in).

## Adaptive learning

Every run, the judge assigns each panelist an **influence** score (how much it drove the
final answer). Those accumulate per `(model, subject)` into a quantitative expertise
profile, viewable with `fuse stats` or the web dashboard. Selection uses it to field the
strongest panel per subject; the judge uses it as a soft prior. Optional 👍/👎 feedback
nudges scores further. Data lives in `~/.era-fusion/fusion.db`.

## Packages

| Package | What it is |
|---|---|
| `@era-fusion/core` | The engine: provider abstraction (Anthropic / OpenAI / Google SDKs), adjudicator, panel dispatch, two-phase judge, SQLite adaptive store (`node:sqlite`, no native deps). |
| `@era-fusion/server` | Hono server: OpenAI-compatible `/v1/chat/completions`, rich SSE `/api/fuse`, feedback + strengths API, serves the web UI. |
| `@era-fusion/cli` | `fuse` — run fusions, `serve`, `setup`, `stats`, `usage`, `feedback`, `doctor`, `config`, `models`. Pipe-friendly. |
| `@era-fusion/web` | React chat UI: live panel view, streamed synthesis, analysis panel, feedback, learned-strengths dashboard. |
| `skills/fuse` | The `/fuse` skill for Claude Code / OpenCode (service-first, CLI fallback). |

## Requirements

- **Node ≥ 22.** The adaptive store uses the built-in `node:sqlite` (no native deps). It is
  stable on Node 24+; on Node 22 it is available but emits an experimental warning.
- **Provider keys** — at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `GOOGLE_API_KEY`, or a logged-in provider CLI for subscription mode.
- **Docker** *(optional)* — only for the agentic **deep** tier's sandboxed code execution.
  Fusion degrades gracefully without it.

## Documentation

- [`docs/ENGINEER_ONBOARDING.md`](docs/ENGINEER_ONBOARDING.md) — first-time setup + connecting provider keys
- [`docs/AGENTIC_FUSION.md`](docs/AGENTIC_FUSION.md) — the sandboxed agentic-panelist tier
- [`docs/MCP.md`](docs/MCP.md) — Era Fusion as an MCP tool for any agentic stack
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — publishing the npm package + integration recipe
- [`docs/fusion-flow.html`](docs/fusion-flow.html) — visual pipeline explainer

## Roadmap

- **Multi-scope decomposition** — split a request into sub-scopes, each with its own
  cross-model panel, then meta-aggregate (data model already structured for it).
- **Derived personas** — promote consistently dominant models into named subject experts.
- Per-model cost/latency budgeting and richer dashboards.

## Contributing

Issues and PRs welcome. CI runs a typecheck + build on Node 22 and 24 — keep both green.
Local check before pushing: `npm run build` (compiles every workspace with `tsc`).

## License

[MIT](./LICENSE) © Alexander Ollman
