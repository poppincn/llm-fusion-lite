# Era Fusion

Multi-model **fusion** with adaptive, learned model strengths — a graphical chat UI, a CLI, an OpenAI-compatible endpoint, and a `/fuse` skill for agentic coding tools (Claude Code / OpenCode).

Inspired by [OpenRouter's "Fusion beats Frontier"](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) and the [`fusion-fable`](https://github.com/duolahypercho/fusion-fable) skill, with one big addition: **it learns which model is the de-facto subject-matter expert over time** and weights the synthesis accordingly.

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

Diversity is **harvested, not manufactured**: the same prompt to different models yields different reasoning paths, tool calls, and sources. No synthetic personas (those can be *derived* later from the learned SME profile).

## Packages

| Package | What it is |
|---|---|
| `@era-fusion/core` | The engine: provider abstraction (Anthropic / OpenAI / Google SDKs), adjudicator, panel dispatch, two-phase judge, SQLite adaptive store (`node:sqlite`, no native deps). |
| `@era-fusion/server` | Hono server: OpenAI-compatible `/v1/chat/completions`, rich SSE `/api/fuse`, feedback + strengths API, serves the web UI. |
| `@era-fusion/cli` | `fuse` — run fusions, `serve`, `setup` (guided key + skill wizard), `stats`, `usage`, `feedback`, `doctor`, `config`, `models`. Pipe-friendly. |
| `@era-fusion/web` | React chat UI: live panel view, streamed synthesis, analysis panel, feedback, and a learned-strengths dashboard. |
| `skills/fuse` | The `/fuse` skill for Claude Code / OpenCode (service-first, CLI fallback). |

## Setup

```bash
git clone <this repo> && cd era-fusion
./scripts/install.sh          # installs deps, builds, puts `fuse`/`fuse-run` on PATH,
                              # installs the /fuse skill into Claude Code + OpenCode
fuse setup                    # guided TUI: paste provider keys + pick defaults
fuse doctor                   # verify environment
```

`fuse setup` is the quickest path: a terminal wizard that takes provider keys (masked, written to `~/.era-fusion/.env`), lets you pick the default judge / panel size / web-search, and installs the `/fuse` skill. Prefer env vars or the dashboard? `export ANTHROPIC_API_KEY=…` (at least one; OpenAI / Google optional) or `fuse serve` → Setup tab work too. Re-run `fuse setup` anytime to add a key — existing keys are kept on Enter; `fuse setup --skill-only` just (re)installs the skill.

Works out-of-the-box with just an Anthropic key (Opus 4.8 + Sonnet 4.6, judged by Opus 4.8). Add OpenAI / Google keys for true cross-provider fusion. Edit `~/.era-fusion/config.json` to change models, panel size, judge, or the auto-panel.

## Distribution (npm package)

Ships as a single bundled **public npm package** — `@alexander-ollman/llm-fusion` — exposing the `fuse` and `fuse-run` bins with the web UI and `/fuse` skill included (no native deps; Node ≥ 22). `npm i -g @alexander-ollman/llm-fusion` (or `npx`), then `fuse setup` to wire the skill into your harnesses. era-code lazily provisions it on demand. Build from source with `npm run pack:release` (output in `./release`). See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for publishing + the era-code integration recipe, and [`docs/ENGINEER_ONBOARDING.md`](docs/ENGINEER_ONBOARDING.md) for first-time setup + connecting provider keys.

## Usage

### CLI
```bash
fuse "What's the best way to design an idempotent webhook consumer?"
echo "summarize this" | fuse --quiet            # pipe-friendly, answer-only on stdout
fuse --panel claude-opus-4-8,gpt-5.5,gemini-3-pro "compare these approaches"
fuse --depth deep "research the current state of X"   # force agentic deep panelists
fuse stats coding                                # learned per-subject strengths
fuse feedback <run-id> up                        # teach it which answers were good
```

### Web UI
```bash
fuse serve            # → http://localhost:8787  (chat · strengths · usage · setup)
# dev: npm run dev:server  &&  npm run dev:web   (Vite proxies /api + /v1)
```

### As a model in Claude Code / OpenCode / Cursor (OpenAI-compatible)
Point any OpenAI-compatible client at the server and use the model id `fusion`:
```
base URL:  http://localhost:8787/v1
model:     fusion
```
Every request fans out to the panel and returns one synthesized answer; non-standard body fields `panel`, `judge`, `panel_size`, `web_search` are honored. Each call feeds the adaptive store.

### As a skill in Claude Code / OpenCode
```
/fuse <your request>
```
or just say "run this through fusion". The skill uses the `fuse` engine when keys are set (with learning), and falls back to orchestrating local model CLIs (`codex`, `gemini`, `claude`) when they aren't.

## Adaptive learning

Every run, the judge assigns each panelist an **influence** score (how much it drove the final answer). Those accumulate per `(model, subject)` into a quantitative expertise profile, viewable with `fuse stats` or the web dashboard. Selection uses it to field the strongest panel for each subject; the judge uses it as a soft prior. Optional 👍/👎 feedback nudges scores further. Data lives in `~/.era-fusion/fusion.db`.

## Roadmap
- **Multi-scope decomposition** — split a request into sub-scopes, each with its own cross-model panel, then meta-aggregate (data model already structured for it).
- **Derived personas** — promote consistently dominant models into named subject experts.
- Per-model cost/latency budgeting and richer dashboards.

## License
MIT
