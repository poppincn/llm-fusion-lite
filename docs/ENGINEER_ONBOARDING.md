# Era Fusion — Engineer Onboarding & Provider Setup

A start-to-finish guide to initialize Era Fusion on a workstation/server and connect API keys for **all** model providers. Target reader: the era-code engineer bringing this online for the first time.

> TL;DR: `./scripts/install.sh` → put keys in `~/.era-fusion/.env` → `fuse doctor` → fix model IDs in `~/.era-fusion/config.json` → `fuse "test question"`.

---

## 1. What this is

Era Fusion answers a request by running it across a **panel of multiple models in parallel**, then a judge model synthesizes one best answer and scores how much each model **influenced** it. Those influence scores accumulate into a per-model, per-subject expertise profile that drives future panel selection and judging. Surfaces: a CLI (`fuse`), an OpenAI-compatible HTTP server + web UI, and a `/fuse` skill for Claude Code / OpenCode.

Monorepo (npm workspaces, TypeScript, ESM): `packages/{core,server,cli,web}` + `skills/fuse`. Adaptive store is built-in `node:sqlite` (no native build step).

---

## 2. Prerequisites

- **Node ≥ 22** (developed/tested on Node 25). Check: `node -v`.
- **git**, **npm ≥ 10**.
- *Optional* model CLIs for the skill's keyless fallback path: `codex`, `gemini`, `claude`.

---

## 3. Initialize

```bash
git clone <repo-url> era-fusion && cd era-fusion
./scripts/install.sh
```

`install.sh` is idempotent and does:
1. `npm install` + `npm run build` (all four packages).
2. Copies the built web UI into `packages/server/public/` (so `fuse serve` serves it in production).
3. Installs launchers `fuse` and `fuse-run` into `~/.local/bin` (override with `ERA_FUSION_BIN`).
4. Installs the `/fuse` skill + slash command into **Claude Code** (`~/.claude/`) and **OpenCode** (`~/.config/opencode/`).
5. Runs `fuse doctor`.

If `~/.local/bin` isn't on your `PATH`, the script prints the `export PATH=…` line to add to your shell profile.

On first run, `fuse` creates `~/.era-fusion/` containing `config.json` (model registry + settings) and `fusion.db` (the learning store).

---

## 4. Connect provider API keys  ← the important part

Era Fusion talks to each provider with its **official SDK**, so each needs its own key.

| Provider | Env var | Get a key | Powers (default panel) |
|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → API Keys | Claude Opus 4.8, Sonnet 4.6, Haiku 4.5 (Haiku = classifier/adjudicator); **default judge** |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | GPT panelist (via Responses API + hosted web search) |
| Google | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) | https://aistudio.google.com/apikey | Gemini panelists (with Google Search grounding) |

**Minimum:** `ANTHROPIC_API_KEY` (the system runs and learns with an all-Claude panel). Add OpenAI + Google for true cross-provider fusion — which is the whole point.

### How to set them (pick one)

- **Recommended — machine-wide `.env`:** create `~/.era-fusion/.env`:
  ```bash
  mkdir -p ~/.era-fusion
  cat > ~/.era-fusion/.env <<'EOF'
  ANTHROPIC_API_KEY=sk-ant-...
  OPENAI_API_KEY=sk-...
  GOOGLE_API_KEY=AIza...
  EOF
  chmod 600 ~/.era-fusion/.env
  ```
  Loaded automatically by `fuse` and the server from any directory.
- **Repo-local `.env`:** `cp .env.example .env` and fill it in (git-ignored).
- **Shell export:** put `export ANTHROPIC_API_KEY=…` in `~/.zshrc` / `~/.bashrc`.

**Precedence:** real environment variables always win; `.env` files never override an already-set variable. Lookup order for `.env`: `~/.era-fusion/.env`, then `./.env`.

### Verify

```bash
fuse doctor
```
Each key shows ✓ (or ○ if unset). "Readiness" should report **≥ 2 models available** for real fusion. `fuse models` lists every model and whether it's available (● available / ○ not).

---

## 5. Make the model IDs match your access  ← do not skip

The default registry in `~/.era-fusion/config.json` ships with **placeholder model strings** for non-Anthropic providers (`gpt-5.5`, `gemini-3-pro`, `gemini-3-flash`). Your org may have different model names/versions enabled — a wrong string returns a 404 from that provider at call time.

1. Confirm the exact model IDs your keys can access:
   - OpenAI: `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | jq '.data[].id'`
   - Google: https://aistudio.google.com/ (model picker) or the Gemini "models.list" endpoint.
   - Anthropic IDs (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`) are correct as shipped.
2. Edit `~/.era-fusion/config.json` → for each entry in `models[]`, set `model` to a real provider string. Keep `id` stable (it's the key used in the learning store and panel config — changing it resets that model's history).
3. Adjust `autoPanel` (which model `id`s are eligible for auto-selection), `defaultJudge`, `classifierModel`, and `panelSize` as desired.

Config fields:
```jsonc
{
  "models": [ { "id", "provider": "anthropic|openai|google", "model", "label",
                "webSearch": true, "costPer1MIn", "costPer1MOut" } ],
  "autoPanel": ["id", ...],   // eligible for adaptive selection
  "defaultJudge": "claude-opus-4-8",
  "classifierModel": "claude-haiku-4-5",   // cheap adjudicator (subject + depth)
  "panelSize": 3,
  "webSearch": true,
  "explorationRate": 0.15     // ε-greedy: chance to try an under-used model
}
```

Test one provider/model end-to-end (a one-model panel still runs the judge):
```bash
fuse --panel gpt-5.5 "Say hello in one short sentence."
fuse --panel gemini-3-pro "Say hello in one short sentence."
```

---

## 6. Validate end-to-end (live smoke test)

```bash
# Full adaptive fusion (auto subject + depth + panel)
fuse "What are the trade-offs of optimistic vs pessimistic locking?"

# You should see: category, depth, the selected multi-model panel, each panelist
# completing, then the streamed synthesized answer, then a run id + cost line.

fuse stats                 # learned per-subject strengths (grows as you run more)
fuse feedback <run-id> up  # optional: record a thumbs-up to bias future selection
```

Server + UI:
```bash
fuse serve                 # → http://localhost:8787  (chat + Strengths dashboard)
curl -s localhost:8787/health | jq      # providers + available panel
```

OpenAI-compatible endpoint (what agentic tools connect to):
```bash
curl -s localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"fusion","messages":[{"role":"user","content":"hi"}]}' | jq '.choices[0].message.content, .fusion.panel'
```

---

## 7. Connect as a model in agentic tools

- **OpenAI-compatible base URL** (Claude Code, OpenCode, Cursor, etc.): point the client at `http://localhost:8787/v1` and select model `fusion`. Every request fans out to the panel and returns one synthesized answer; each call feeds the learning store. Optional non-standard body fields: `panel`, `judge`, `panel_size`, `web_search`.
- **`/fuse` skill** (installed by `install.sh`): in Claude Code / OpenCode run `/fuse <request>` or say "run this through fusion." It prefers the `fuse` engine (with learning) and falls back to orchestrating local `codex`/`gemini`/`claude` CLIs when no API keys are present.

---

## 8. Operational notes

- **State:** `~/.era-fusion/config.json` (settings) and `~/.era-fusion/fusion.db` (SQLite learning store — runs, influence/contribution scores, feedback). Back these up to preserve learned expertise. Override location with `ERA_FUSION_HOME`.
- **Secrets:** never commit keys. `.gitignore` covers `.env`, `.env.*`, and `.era-fusion/`. Note the store persists prompts and answers — treat `fusion.db` as sensitive.
- **Cost:** a fusion run costs ~N× a single call (N = panel size), more on `deep` depth (agentic tool loop). Tune `panelSize`, use `--depth light|standard`, or trim `autoPanel`. Per-run cost estimate prints when model cost metadata is set in config.

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `doctor` shows a key ○ despite being set | It's in a `.env` that isn't loaded — use `~/.era-fusion/.env` or `./.env`, or `export` it. Real env wins over `.env`. |
| "No usable models" / 404 from a provider | Model string in `config.json` doesn't match your access — fix `models[].model` (§5). |
| 401 / authentication error | Bad/rotated key, or wrong env var (Google accepts `GOOGLE_API_KEY` or `GEMINI_API_KEY`). |
| Panelist shows an error but the run still completes | By design — a failed panelist is reported, gets 0 influence, and the judge synthesizes from the rest. |
| No citations on web-searched answers | Provider returned grounding in a shape the extractor didn't match; verify the model actually supports the hosted web tool. Citation extraction is best-effort and provider-specific. |
| Adaptive panel never changes | Not enough history yet, or `explorationRate` too low. Run more, or raise `explorationRate`. |

---

## 10. First-run checklist

- [ ] `./scripts/install.sh` completed; `fuse` and `fuse-run` on PATH.
- [ ] Keys in `~/.era-fusion/.env`; `fuse doctor` shows the providers you expect and ≥ 2 models available.
- [ ] `models[].model` strings in `config.json` match real, accessible model IDs (§5).
- [ ] `fuse "…"` runs a real multi-model fusion and `fuse stats` shows growing data.
- [ ] `fuse serve` UI loads; `/v1/chat/completions` returns a synthesized answer.
- [ ] `/fuse` works inside Claude Code / OpenCode.
- [ ] (If using as a shared service) decide where to host the server and how keys are provisioned (env vars in the service environment, not committed).

---

## 11. Known gaps to be aware of

- Non-Anthropic default model IDs are placeholders — **expect to set §5** before the OpenAI/Google panelists work.
- Provider citation/usage extraction is best-effort against current SDK response shapes; verify on first live runs.
- Repo is not yet committed and has no `.era/memory` governance (constitution/directives) bootstrapped — do that per house rules before substantive changes.
- Next planned phase: multi-scope decomposition (one request → several sub-scopes, each its own panel, then meta-aggregation). Data model is already structured for it.
