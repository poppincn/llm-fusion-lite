# LLM Fusion — Engineer Onboarding & Provider Setup

Handover for the era-code engineer bringing LLM Fusion online. Covers the two ways to initialize it and — the important part — connecting API keys for **all** model providers.

> **Fastest path (era-code / production):** publish/consume the `@era-laboratories/llm-fusion` package → `fuse setup` → put keys in `~/.era-fusion/.env` → `fuse doctor` → fix model IDs in `~/.era-fusion/config.json` → `fuse "test"`.
> **Dev path (contributing to the engine):** clone → `./scripts/install.sh` → same key + config steps.

---

## 1. What this is

LLM Fusion answers a request by running it across a **panel of multiple models in parallel**, then a judge model synthesizes one best answer and scores how much each model **influenced** it. Those influence scores accumulate into a per-model, per-subject expertise profile that drives future panel selection and judging. Surfaces: a CLI (`fuse`), an OpenAI-compatible server + web UI, and a `/fuse` skill for Claude Code / OpenCode.

Repo: `Alexander-Ollman/llm-fusion` (private). Monorepo (npm workspaces, TypeScript, ESM): `packages/{core,server,cli,web}` + `skills/fuse`. Distributed as one bundled package. No native deps (uses built-in `node:sqlite`).

---

## 2. Prerequisites

- **Node ≥ 22** (developed on Node 25) — required for `node:sqlite`. Check `node -v`. era-code should gate provisioning on this.
- **git**, **npm ≥ 10**.
- *Optional* model CLIs for the skill's keyless fallback: `codex`, `gemini`, `claude` (a Claude Code harness usually already has `claude`).

---

## 3. Initialize — pick a path

### Path A — via the package (recommended for era-code / production)

Distributed as a single bundled package, **`@era-laboratories/llm-fusion`**, exposing the `fuse` and `fuse-run` bins with the web UI and `/fuse` skill included. era-code **lazily provisions** it (installs on demand; not a hard dependency).

1. **Registry auth.** The package targets a private registry (GitHub Packages). Consumer `~/.npmrc`:
   ```
   @era-laboratories:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}   # PAT with read:packages
   ```
   > ⚠️ **Before first publish:** GitHub Packages requires the npm scope to match the owning GitHub org. `@era-laboratories` needs the repo under an `era-laboratories` org (it's currently under user `Alexander-Ollman`). Resolve one of: transfer the repo to that org, re-scope to `@alexander-ollman/llm-fusion`, or use a different private registry. See `docs/PUBLISHING.md`.

2. **Install + wire the skill** (what era-code's provision step runs):
   ```bash
   npm install -g @era-laboratories/llm-fusion   # or into era-code's managed prefix
   fuse setup                                     # installs /fuse into Claude Code + OpenCode
   fuse doctor                                    # verify keys / CLIs
   ```
   The lazy-provision recipe for era-code (idempotent `provisionFusion()`), and why it must **not** be a hard dependency, are in `docs/PUBLISHING.md`.

3. To build the publishable artifact from source: `npm run pack:release` → `./release` (then `cd release && npm publish`). Details in `docs/PUBLISHING.md`.

### Path B — local dev / contributor

```bash
git clone git@github.com:Alexander-Ollman/llm-fusion.git && cd llm-fusion
./scripts/install.sh
```
`install.sh` is idempotent: `npm install` + build all packages, bundle the web UI into the server, put `fuse`/`fuse-run` launchers on PATH (`~/.local/bin`, override `ERA_FUSION_BIN`), install the `/fuse` skill into Claude Code + OpenCode, and run `fuse doctor`. If `~/.local/bin` isn't on `PATH`, it prints the `export` line to add.

Either path creates `~/.era-fusion/` on first run: `config.json` (model registry + settings) and `fusion.db` (the learning store).

---

## 4. Connect provider API keys  ← the important part

The engine calls each provider with its **official SDK**, so each needs its own key.

| Provider | Env var | Get a key | Powers (default panel) |
|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → API Keys | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 (Haiku = classifier/adjudicator); **default judge** |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | GPT panelist (Responses API + hosted web search) |
| Google | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) | https://aistudio.google.com/apikey | Gemini panelists (Google Search grounding) |

**Minimum:** `ANTHROPIC_API_KEY` (runs + learns with an all-Claude panel). Add OpenAI + Google for true cross-provider fusion — the whole point.

### How to set them (pick one)

- **Recommended — machine-wide `.env`** (works from any directory):
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
2. Edit `~/.era-fusion/config.json` → set each `models[].model` to a real provider string. Keep `id` stable (it's the key in the learning store; changing it resets that model's history).
3. Tune `autoPanel` (ids eligible for adaptive selection), `defaultJudge`, `classifierModel`, `panelSize`, `explorationRate`.

```jsonc
{
  "models": [ { "id", "provider": "anthropic|openai|google", "model", "label",
                "webSearch": true, "costPer1MIn", "costPer1MOut" } ],
  "autoPanel": ["id", ...],
  "defaultJudge": "claude-opus-4-8",
  "classifierModel": "claude-haiku-4-5",   // cheap adjudicator (subject + depth)
  "panelSize": 3,
  "webSearch": true,
  "explorationRate": 0.15
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
fuse serve                 # → http://localhost:8787 (chat + Strengths dashboard)
curl -s localhost:8787/health | jq
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

---

## 8. Operational notes

- **State:** `~/.era-fusion/config.json` (settings) + `~/.era-fusion/fusion.db` (SQLite learning store: runs, influence scores, feedback). Back these up to preserve learned expertise. Relocate with `ERA_FUSION_HOME`.
- **Secrets:** never commit keys. `.gitignore` covers `.env`, `.env.*`, `.era-fusion/`, and `release/`. The store persists prompts + answers — treat `fusion.db` as sensitive.
- **Cost:** a run is ~N× a single call (N = panel size), more on `deep` depth (agentic tool loop). Tune `panelSize`, use `--depth light|standard`, or trim `autoPanel`. Per-run cost estimate prints when model cost metadata is set.
- **CLI commands:** `fuse` (run), `serve`, `stats [subject]`, `feedback <id> up|down`, `doctor`, `setup`, `config`, `models`. Plus the `fuse-run` bin used by the skill.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `doctor` shows a key ○ despite being set | It's in a `.env` that isn't loaded — use `~/.era-fusion/.env` or `./.env`, or `export` it. Real env wins over `.env`. |
| "No usable models" / 404 from a provider | `models[].model` doesn't match your access — fix it (§5). |
| 401 / authentication error | Bad/rotated key, or wrong env var (Google accepts `GOOGLE_API_KEY` or `GEMINI_API_KEY`). |
| `npm install -g @era-laboratories/llm-fusion` 401/404 | Registry auth/scope: check `~/.npmrc` (read:packages token) and the scope-vs-org rule in §3 / `docs/PUBLISHING.md`. |
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
- [ ] `fuse serve` UI loads; `/v1/chat/completions` returns a synthesized answer.
- [ ] `/fuse` works inside Claude Code / OpenCode.
- [ ] (Hosted) decided where the server runs and how keys are provisioned (env, not committed).

---

## 11. Known gaps / open items

- Non-Anthropic default model IDs are **placeholders** — expect to do §5 before OpenAI/Google panelists work.
- **GitHub Packages scope vs owner** must be resolved before publishing (§3 / `docs/PUBLISHING.md`).
- Provider citation/usage extraction is best-effort against current SDK response shapes — verify on first live runs.
- No live API call has been run yet (no keys in the build environment); first run may surface a model-ID or response-shape tweak.
- Repo has no `.era/memory` governance (constitution/directives) bootstrapped — do that per house rules before substantive changes.
- Next planned phase: **multi-scope decomposition** (one request → several sub-scopes, each its own panel, then meta-aggregation). Data model is already structured for it.
