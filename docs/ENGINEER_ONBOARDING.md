# LLM Fusion — Engineer Onboarding & Provider Setup

Handover for the era-code engineer bringing LLM Fusion online. Covers the two ways to initialize it and — the important part — connecting API keys for **all** model providers.

> **Fastest path (era-code / production):** install the public `@alexander-ollman/llm-fusion` package → `fuse setup` → add provider keys → `fuse doctor` → confirm model IDs → `fuse "test"`. Keys and model config can be done either via files (`~/.era-fusion/.env` + `config.json`) **or** the served dashboard's **Setup** tab (`fuse serve`).
> **Dev path (contributing to the engine):** clone → `./scripts/install.sh` → same key + config steps.

---

## 1. What this is

LLM Fusion answers a request by running it across a **panel of multiple models in parallel**, then a judge model synthesizes one best answer and scores how much each model **influenced** it. Those influence scores accumulate into a per-model, per-subject expertise profile that drives future panel selection and judging. Surfaces: a CLI (`fuse`), an OpenAI-compatible server + web UI, and a `/fuse` skill for Claude Code / OpenCode.

Repo: `Alexander-Ollman/llm-fusion` (GitHub repo currently private; the **npm package is public**). Monorepo (npm workspaces, TypeScript, ESM): `packages/{core,server,cli,web}` + `skills/fuse`. Distributed as one bundled package. No native deps (uses built-in `node:sqlite`).

---

## 2. Prerequisites

- **Node ≥ 22** (developed on Node 25) — required for `node:sqlite`. Check `node -v`. era-code should gate provisioning on this.
- **git**, **npm ≥ 10**.
- *Optional* model CLIs for the skill's keyless fallback: `codex`, `gemini`, `claude` (a Claude Code harness usually already has `claude`).

---

## 3. Initialize — pick a path

### Path A — via the package (recommended for era-code / production)

Distributed as a single bundled **public npm package**, **`@alexander-ollman/llm-fusion`**, exposing the `fuse` and `fuse-run` bins with the web UI and `/fuse` skill included. era-code **lazily provisions** it (installs on demand; not a hard dependency).

1. **Install + wire the skill** (what era-code's provision step runs — public, no auth):
   ```bash
   npm install -g @alexander-ollman/llm-fusion   # or `npx @alexander-ollman/llm-fusion doctor`
   fuse setup                                     # guided TUI: paste keys + defaults, installs /fuse
   fuse doctor                                    # verify keys / CLIs
   ```
   The lazy-provision recipe for era-code (idempotent `provisionFusion()`), and why it must **not** be a hard dependency, are in `docs/PUBLISHING.md`.

2. To build + publish the artifact from source: `npm run pack:release` → `./release`, then `npm login` (as `alexander-ollman`) and `cd release && npm publish`. Details in `docs/PUBLISHING.md`.

### Path B — local dev / contributor

```bash
git clone git@github.com:Alexander-Ollman/llm-fusion.git && cd llm-fusion
./scripts/install.sh
```
`install.sh` is idempotent: `npm install` + build all packages, put `fuse`/`fuse-run` launchers on PATH (`~/.local/bin`, override `ERA_FUSION_BIN`), install the `/fuse` skill into Claude Code + OpenCode, and run `fuse doctor`. The dev server serves the web UI straight from `packages/web/dist` (no copy step). If `~/.local/bin` isn't on `PATH`, it prints the `export` line to add.

Either path creates `~/.era-fusion/` on first run: `config.json` (model registry + settings) and `fusion.db` (the learning store).

---

## 4. Configure providers — API key or subscription  ← the important part

Each provider (Anthropic / OpenAI / Google) runs in one of **two auth modes**, chosen per provider in `fuse setup` (or in `~/.era-fusion/config.json` under `providerAuth`). Both modes flow through the **same engine** — panel selection, two-phase judge, adaptive learning — because everything goes through `Provider.complete()`.

- **`api` (default)** — the provider's **official SDK** with an API key. Reports token usage and cost.
- **`subscription`** — the provider's **CLI run as a subprocess** using your logged-in **Pro/Max plan**, **no API key**. `fuse setup` installs/updates the CLI via `npm i -g` as needed and prints the login command.

| Provider | api env var | subscription CLI (npm pkg) | subscription login | Powers (default panel) |
|---|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` (https://console.anthropic.com/) | `claude` (`@anthropic-ai/claude-code`) | `claude /login` | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 (Haiku = classifier/adjudicator); **default judge** |
| OpenAI | `OPENAI_API_KEY` (https://platform.openai.com/api-keys) | `codex` (`@openai/codex`) | `codex login` | GPT panelist (Responses API + hosted web search in api mode) |
| Google | `GOOGLE_API_KEY` / `GEMINI_API_KEY` (https://aistudio.google.com/apikey) | `gemini` (`@google/gemini-cli`) | `gemini` | Gemini panelists (Google Search grounding in api mode) |

**Minimum:** any one provider configured (api **or** subscription). Add more for true cross-provider fusion — the whole point.

**Subscription-mode limitations:** CLI calls report **no token usage**, so cost metrics show **$0/unmetered** for subscription panelists. If a subscription provider is the **judge**, its structured-JSON judge output is best-effort (CLIs are less reliable at strict JSON) — **keep the judge on an api/Anthropic model** when possible.

### How to set them (pick one)

- **Easiest — `fuse setup` wizard:** a terminal TUI that, **per provider**, asks how to authenticate — **API key** (masked input → `~/.era-fusion/.env`, mode `0600`, applied live), **Subscription login** (installs/updates the provider CLI via `npm i -g` and prints the login command), or **Skip** — then lets you pick the default judge / panel size / web-search. Re-run anytime to change a provider's mode or add a key. Use `fuse setup --no-install` to skip the skill copy, or `fuse setup --skill-only` to only (re)install the skill.
- **Machine-wide `.env`** (works from any directory):
  ```bash
  mkdir -p ~/.era-fusion
  cat > ~/.era-fusion/.env <<'EOF'
  ANTHROPIC_API_KEY=sk-ant-...
  OPENAI_API_KEY=sk-...
  GOOGLE_API_KEY=AIza...
  EOF
  chmod 600 ~/.era-fusion/.env
  ```
- **Repo-local `.env`** (dev path): `cp .env.example .env` and fill it (git-ignored).
- **Shell export** / service environment: `export ANTHROPIC_API_KEY=…` in your profile or the service's env config (preferred for a hosted server).
- **Dashboard (no file editing):** `fuse serve` → open the UI → **Setup** tab → paste each provider key and Save. This writes `~/.era-fusion/.env` on the server and applies the key live (no restart).

**Precedence:** real environment variables always win; `.env` never overrides an already-set variable. `.env` lookup order: `~/.era-fusion/.env`, then `./.env`. era-code can provision keys through its existing env/config management — just ensure these names land in the environment or `~/.era-fusion/.env`.

### Verify
```bash
fuse doctor    # each key ✓/○; "Readiness" should report ≥ 2 models for real fusion
fuse models    # ● available / ○ not, per model
```

---

## 5. Make the model IDs match your access  ← do not skip

The default registry in `~/.era-fusion/config.json` ships **placeholder model strings** for non-Anthropic providers (`gpt-5.5`, `gemini-3-pro`, `gemini-3-flash`). Your org may have different names/versions — a wrong string 404s at call time.

1. Confirm the exact IDs your keys can access:
   - OpenAI: `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | jq '.data[].id'`
   - Google: Google AI Studio model picker, or the Gemini `models.list` endpoint.
   - Anthropic IDs (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`) are correct as shipped.
2. Set each model's real provider string — either edit `~/.era-fusion/config.json` (`models[].model`) **or** use the dashboard **Setup → Models** editor (add/edit/delete rows, toggle auto-panel, set costs). Keep `id` stable (it's the key in the learning store; changing it resets that model's history).
3. Tune `autoPanel` (ids eligible for adaptive selection), `defaultJudge`, `classifierModel`, `panelSize`, `explorationRate` — in the file or under **Setup → Settings**.

```jsonc
{
  "models": [ { "id", "provider": "anthropic|openai|google", "model", "label",
                "webSearch": true, "costPer1MIn", "costPer1MOut" } ],
  "autoPanel": ["id", ...],
  "defaultJudge": "claude-opus-4-8",
  "classifierModel": "claude-haiku-4-5",   // cheap adjudicator (subject + depth)
  "panelSize": 3,
  "webSearch": true,
  "explorationRate": 0.15,
  // per-provider auth mode; absent provider ⇒ "api". Set "subscription" to use
  // the provider's CLI (claude/codex/gemini) on your Pro/Max plan, no API key.
  "providerAuth": { "anthropic": "api", "openai": "subscription" }
}
```

Test a single provider/model (a one-model panel still runs the judge):
```bash
fuse --panel gpt-5.5 "Say hello in one short sentence."
fuse --panel gemini-3-pro "Say hello in one short sentence."
```

---

## 6. Validate end-to-end (live smoke test)

```bash
fuse "What are the trade-offs of optimistic vs pessimistic locking?"
# Expect: category, depth, the selected multi-model panel, each panelist completing,
# then the streamed synthesized answer, then a run id + cost line.

fuse stats                 # learned per-subject strengths (grows with use)
fuse feedback <run-id> up  # optional thumbs-up to bias future selection
```

Server + UI:
```bash
fuse serve                 # → http://localhost:8787  (Chat · Strengths · Usage · Setup)
curl -s localhost:8787/health | jq
fuse usage                 # token + cost totals per provider/model (also the Usage tab)
```

OpenAI-compatible endpoint (what agentic tools connect to):
```bash
curl -s localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"fusion","messages":[{"role":"user","content":"hi"}]}' \
  | jq '.choices[0].message.content, .fusion.panel'
```

---

## 7. Use it from agentic tools

- **OpenAI-compatible base URL** (Claude Code / OpenCode / Cursor): point the client at `http://localhost:8787/v1`, model `fusion`. Every request fans out to the panel and returns one synthesized answer; optional non-standard body fields: `panel`, `judge`, `panel_size`, `web_search`. Each call feeds the learning store.
- **`/fuse` skill** (installed by `fuse setup` / `install.sh`): run `/fuse <request>` or say "run this through fusion." Prefers the `fuse` engine (with learning); falls back to orchestrating local `codex`/`gemini`/`claude` CLIs when no keys are present — so it works for era-code users even before keys are provisioned.
- **Served dashboard** (`fuse serve`): besides Chat + Strengths, the UI has a **Usage** tab (total tokens + cost per provider and per model) and a **Setup** tab (paste provider keys → `~/.era-fusion/.env`; add/edit/remove models; set judge, panel size, web search, exploration). `fuse usage` prints the same totals in the terminal.

---

## 8. Operational notes

- **State:** `~/.era-fusion/config.json` (settings) + `~/.era-fusion/fusion.db` (SQLite learning store: runs, influence scores, feedback). Back these up to preserve learned expertise. Relocate with `ERA_FUSION_HOME`.
- **Secrets:** never commit keys. `.gitignore` covers `.env`, `.env.*`, `.era-fusion/`, and `release/`. The store persists prompts + answers — treat `fusion.db` as sensitive.
- **Cost:** a run is ~N× a single call (N = panel size), more on `deep` depth (agentic tool loop). Tune `panelSize`, use `--depth light|standard`, or trim `autoPanel`. Per-run cost estimate prints when model cost metadata is set.
- **CLI commands:** `fuse` (run), `serve`, `stats [subject]`, `usage`, `feedback <id> up|down`, `doctor`, `setup`, `config`, `models`. Plus the `fuse-run` bin used by the skill.
- **Dashboard API** (for custom integrations): `GET /api/usage`, `GET /api/config`, `PUT /api/config` (edit settings + model registry), `POST /api/keys` (set a provider key), `GET /api/strengths`, `POST /api/feedback`, `POST /api/fuse` (SSE), plus the OpenAI-compatible `/v1/*`.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `doctor` shows a key ○ despite being set | It's in a `.env` that isn't loaded — use `~/.era-fusion/.env` or `./.env`, or `export` it. Real env wins over `.env`. |
| "No usable models" / 404 from a provider | `models[].model` doesn't match your access — fix it (§5). |
| 401 / authentication error | Bad/rotated key, or wrong env var (Google accepts `GOOGLE_API_KEY` or `GEMINI_API_KEY`). |
| `npm install -g @alexander-ollman/llm-fusion` fails | It's public — no auth to install. If publishing, ensure you're `npm login`'d as the `alexander-ollman` scope owner (`docs/PUBLISHING.md`). |
| `node:sqlite` / "Cannot find package 'sqlite'" | Node < 22, or an old bundle — upgrade Node ≥ 22 and rebuild (`npm run pack:release`). |
| Panelist errors but the run still completes | By design — a failed panelist is reported, gets 0 influence, the judge uses the rest. |
| No citations on web-searched answers | Provider returned grounding in a shape the extractor didn't match; verify the model supports the hosted web tool. Best-effort + provider-specific. |
| Adaptive panel never changes | Not enough history yet, or `explorationRate` too low — run more, or raise it. |

---

## 10. First-run checklist

- [ ] Node ≥ 22.
- [ ] Installed: package + `fuse setup` (Path A) **or** `./scripts/install.sh` (Path B); `fuse` + `fuse-run` on PATH.
- [ ] Keys in `~/.era-fusion/.env` (or the service env); `fuse doctor` shows expected providers and ≥ 2 models available.
- [ ] `models[].model` strings in `config.json` match real, accessible model IDs (§5).
- [ ] `fuse "…"` runs a real multi-model fusion; `fuse stats` shows growing data.
- [ ] `fuse serve` UI loads (Chat · Strengths · Usage · Setup); `/v1/chat/completions` returns a synthesized answer.
- [ ] Dashboard **Usage** shows per-provider totals after a run; **Setup** can set a key + add/edit a model.
- [ ] `/fuse` works inside Claude Code / OpenCode.
- [ ] (Hosted) decided where the server runs and how keys are provisioned (env, not committed).

---

## 11. Known gaps / open items

- Non-Anthropic default model IDs are **placeholders** — expect to do §5 (or use the dashboard **Setup** tab) before OpenAI/Google panelists work.
- Publishing requires `npm login` as the `@alexander-ollman` scope owner; the package is public on install (`docs/PUBLISHING.md`).
- Provider citation/usage extraction is best-effort against current SDK response shapes — verify on first live runs.
- No live API call has been run yet (no keys in the build environment); first run may surface a model-ID or response-shape tweak.
- Repo has no `.era/memory` governance (constitution/directives) bootstrapped — do that per house rules before substantive changes.
- Next planned phase: **multi-scope decomposition** (one request → several sub-scopes, each its own panel, then meta-aggregation). Data model is already structured for it.
