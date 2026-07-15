# Era Fusion — Handover (for a fresh agentic coding session)

You're taking over **Era Fusion**: a self-hosted, multi-model "fusion" engine that dispatches a prompt to a
panel of frontier models, has a judge **synthesize** one best answer, and **learns each model's per-subject
strengths over time**. Surfaces: OpenAI-compatible server + web dashboard, a `fuse` CLI, and a `/fuse`
agentic skill. Published as the public npm package **`@alexanderollman/llm-fusion`**.

Read [`WORKBOOK.md`](WORKBOOK.md) for the full story and the research rationale. Read [`../fusion-flow.html`](../fusion-flow.html)
for the visual pipeline. This doc is the operational get-started + what to do next.

---

## Current state (working)

- Engine, server, CLI, web, skill all build and run. Latest commit on `main`.
- **Cross-provider fusion validated** (Opus 4.8 + GPT-5.5 + Gemini 3.5 Flash, judged by Opus).
- **Benchmark harness** works against GPQA-Diamond (objective grading).
- **Optimization techniques shipped** (MoA refine, debate, pairwise rank, confidence, self-consistency, verify),
  composable via `TechniqueConfig`; `standard` tier = base flow, `deep` = all on.
- **Benchmark (GPQA-D 11–18), pre-pinning:** `fusion-deep` 87.5% > base `fusion` 75% > best single 62.5%.
- **Benchmark (GPQA-D 11–18), AFTER model-pinning fix** (`scripts/bench/data/out-pinned-11-18.json`): base `fusion` **87.5%** = `fusion-deep` **87.5%** > best single `gpt-5.5` **75%** > `gemini-3.5-flash` 50% > `claude-opus-4-8` 37.5%. **Pinning lifted base fusion (75→87.5) and the best single (62.5→75), erasing deep's apparent edge** (deep added +40% latency, 0 accuracy on this slice).

### ✅ RESOLVED (2026-06-26): broken grader caused a false "fusion loses"; clean run reverses it

The old harness (`run.mjs` `pickLetter`) graded MCQ by the **first** A–H letter, grabbing letters from the reasoning
("**A** is a distractor… answer is C" → graded A). Same cached answers: old grader **73.2%** vs fixed **92.6%** (disagree
**23.5%**), and it hits *verbose* answers (fusion synthesis ≫ terse singles) hardest. The clean-grader, paired,
variance-controlled judge run (`judge-eval.mjs`, GPQA-D 1–50, k=3, `judges-50.json`) **reverses §6.2–6.3**:

| Judge | Acc | 95% CI |
|---|---|---|
| claude-opus-4-8 | **96.0%** | [90, 100] |
| gpt-5.5 | **96.0%** | [90, 100] |
| gemini-3.5-flash | **95.3%** | [92, 99.3] |
| gemini-2.5-pro | 87.3% | [76.7, 93.3] |

Baselines: best single (gpt-5.5) **94%**, majority-vote **94%**. **So synthesis ≥ vote ≥ best single** (top judges 95–96%
> 94%) — fusion is competitive with frontier; the "judge destroys the panel" claim was the grader. Also: **`gemini-2.5-pro`
is a significantly worse judge** (−8.7 pts, paired CI excludes 0); the other three tie, and the *cheap* `gemini-3.5-flash`
ties the frontier judges (cost-relevant for `defaultJudge`). Caveats: n=50, single panel snapshot, depth `standard`; top
three are a statistical tie. The §6.1 (wrong model) and §6.4 (self-preference) *mechanism* fixes stand; only the §6.2–6.3
*accuracy verdicts* were wrong. The block below is kept as the record of how the artifact arose.

### ~~KEY FINDING (2026-06-24): the judge is the bottleneck, and the n=8 win didn't hold~~ (see retraction above)

A larger slice **GPQA-D 19–34** (`scripts/bench/data/out-pinned-19-34.json`, 16 items, 0 errors) flips the story:

| system | 19–34 | combined 11–34 (24) |
| --- | --- | --- |
| `gpt-5.5` (single) | **87.5%** | **83.3%** ← best |
| `gemini-3.5-flash` (single) | 81.3% | 70.8% |
| **`fusion` (Opus judge)** | **75.0%** | **79.2%** |
| `claude-opus-4-8` (single) | 62.5% | 54.2% |
| **panel majority-vote (approx)** | **~93.8%** | — |

**On 24 GPQA-D items, fusion (79.2%) does NOT beat the best single (gpt-5.5 83.3%).** The earlier "+12.5" was a lucky slice. Worse: on 19–34 a **plain majority vote of the panel scores ~94%** while the Opus-judge synthesis delivers **75%** — *the judge is actively destroying the panel's collective knowledge.*

Mechanism (from captured per-item influence, all 4 fusion-losses on 19–34 had the correct answer present in the panel):
- **Judge self-preference** (gpqa-30, 31): the Opus judge weighted the *wrong* `claude-opus-4-8` panelist at 0.85–0.92 while the *correct* gpt-5.5 + gemini got 0.08–0.12. `judge.ts` `panelDigest` shows the judge each panelist's real `id`/label, so the Opus judge over-trusts the Opus answer. (`refinePanel` already anonymizes peers as "Solver A/B/C"; the judge does not.)
- **Synthesis failure with correct inputs** (gpqa-20): gpt-5.5 + gemini both correct at **0.95** influence, yet the final answer was still wrong — the synthesis step itself flipped it.
- The judge here (`claude-opus-4-8`) is the **weakest single model** on this set (54%); using your weakest model to adjudicate a stronger panel is self-defeating.

**⚠️ Evaluation caveat (discovered validating the fix below):** re-running the **identical** 19–34 config twice moved *every*
system ±6–12 pts (`out-anon-19-34.json` vs `out-pinned-19-34.json`) — subscription models are non-deterministic and
re-answer each run. **Run-to-run variance on 16 items dwarfs the effects we're testing**, so single-slice A/Bs are
unreliable. **Addressed:** `scripts/bench/judge-eval.mjs` now runs a paired design — `snapshot` caches the panel once,
`judges` crosses every candidate judge over the *identical* cached panels with k repeated samples + bootstrap CIs. The
strongest-judge question (fix #2) is tested there. A judge-comparison run over GPQA-D 1–50 is in progress
(`scripts/bench/data/panels-50.json` → `judges-50.json`). New judges (incl. Baseten GLM 5.2 / Minimax M3 via the new
`openai-compatible` provider) re-use the same cache — cheap + directly comparable.

**Candidate fixes (need a decision — several touch the deliberate "synthesis over selection" design):**
1. ✅ **DONE — Anonymize panelist identity in the judge.** `panelDigest`/priors/pairwise now show "Panelist N", contributions keyed by position → modelId. Removes self-preference; design-consistent. **But the validation run was inconclusive (variance, above) and gpqa-31 showed the anonymized judge STILL weighting a wrong panelist 0.96 — identity bias isn't the whole story; the judge can't discriminate correctness on hard items.** Kept (strictly correct, no downside) but not a proven accuracy win.
2. **Use the strongest model as judge** (or any model not also on the panel) — e.g. `--judge gpt-5.5`; re-run *under a variance-controlled regime*.
3. **Add an optional plurality/majority aggregator for objective/short-answer tasks** (or feed the plurality to the judge as a strong prior it must justify overriding). Contradicts pure-synthesis, so it's a product call. (Floor: gpqa-33 had 2/3 panelists wrong — plurality loses there too.)
4. **Judge discrimination** — surface signals the judge can't fake (code re-derivation, cross-checks) instead of asking it to self-assess correctness.
5. **Confidence calibration** (open bug #3) — down-weight confident-but-wrong panelists.

*Until the judge bottleneck is addressed (and evaluation is made rigorous), the headline "fusion beats frontier" is NOT supported on GPQA-D.*

---

## Repo map

```
packages/
  core/src/
    fusion.ts       # orchestrator: adjudicate → select panel → dispatch → (refine→rank) → judge → (SC→verify) → learn
    adjudicate.ts   # cheap subject + depth (light/standard/deep) classification
    judge.ts        # two-phase judge: analysis (influence + priors + pairwise) then streamed synthesis
    techniques.ts   # MoA refinePanel, pairwiseRank, selectConsistent (self-consistency), verifyAndRevise, parseConfidence
    store.ts        # node:sqlite: runs, contributions (influence→SME), feedback, usage; selectPanel (ε-greedy)
    config.ts       # model registry, providerAuth (api|subscription), TECHNIQUES_OFF/DEEP, resolveTechniques
    providers/      # anthropic.ts, openai.ts, google.ts (depth→tools), cli.ts (subscription CLIs), index.ts
    env.ts          # ~/.era-fusion/.env loader + setProviderKey
  server/src/       # app.ts (routes), server.ts, bin.ts (Hono)
  cli/src/index.ts  # fuse CLI (commander + clack setup wizard); fuse-run.ts launcher
  web/src/          # React dashboard: ChatView, StrengthsView, UsageView, SetupView, api.ts
skills/fuse/        # SKILL.md + scripts/fuse-run.sh (service-first, CLI fallback) + commands/fuse.md
scripts/
  bench/run.mjs     # benchmark harness (systems incl. fusion / fusion-deep), --offset/--limit/--panel/--out/--dry-run
  bench/gpqa_to_jsonl.py   # GPQA CSV → MCQ JSONL
  build-package.sh + gen-release-pkg.mjs  # → ./release (the publishable bundle)
  install.sh        # dev install: build, PATH launchers, install skill
docs/               # ENGINEER_ONBOARDING.md, PUBLISHING.md, fusion-flow.html
```

State lives in **`~/.era-fusion/`**: `config.json` (registry, `providerAuth`, panel), `.env` (keys), `fusion.db` (learning store).

---

## How to run

```bash
npm install && npm run build          # build all workspaces
fuse doctor                           # check providers/keys/CLIs  (--probe to live-check models)
fuse "your question"                  # run a fusion (streams)
fuse serve                            # http://localhost:8787  (Chat · Strengths · Usage · Setup)
npm run pack:release                  # rebuild ./release  (REQUIRED for the global `fuse` to pick up engine changes)
```

Benchmark:
```bash
npm run build:core
node scripts/bench/run.mjs scripts/bench/data/gpqa_diamond.jsonl \
  --systems fusion,fusion-deep,claude-opus-4-8,gpt-5.5,gemini-3.5-flash \
  --panel claude-opus-4-8,gpt-5.5,gemini-3.5-flash --offset 10 --limit 8 --out scripts/bench/data/out.json
node scripts/bench/run.mjs <data.jsonl> --dry-run   # validate, no API calls
```

---

## Environment gotchas (this machine)

- **Node ≥ 22 required** (uses built-in `node:sqlite`; loaded via `createRequire` so bundlers keep the prefix).
- **Auth modes** (`~/.era-fusion/config.json` → `providerAuth`): `anthropic` + `openai` = **subscription** (via `claude` / `codex` CLIs), `google` = **api** (key in `.env`). Subscription = **unmetered $**, tokens **estimated**.
- **Valid model strings:** `gemini-3.5-flash` and `gemini-2.5-pro` work; `gemini-3-*` and `gemini-3.5-pro` **404**. Always `fuse doctor --probe` after changing model IDs.
- **The global `fuse` is symlinked to `~/era-fusion/release`** — after any engine change run `npm run pack:release` or the installed CLI won't see it. (The benchmark uses `packages/core/dist` directly, so `npm run build:core` is enough for benchmarking.)
- **Benchmark data is gated + gitignored:** GPQA lives in `scripts/bench/data/` (needs a Hugging Face token; the dataset is license-gated — accept terms on the dataset page). `release/` and `bench-*.json` are also gitignored.
- **`noLearn: true`** is set for benchmark fusion runs so they don't pollute the SME store.
- **Commit cadence:** the owner expects work committed and pushed to `main` when done (end commit messages with the Co-Authored-By trailer; this session has been pushing directly to `main`).

---

## Open issues / bugs found

1. ✅ **FIXED — Subscription-CLI transient failures score as wrong.** `cli.ts` now retries once on a non-abort subprocess failure (benefits panelists, judge, classifier), and the harness baseline retries once on an empty/errored single-model call. Genuine aborts are not retried.
2. ⚠️ **PARTIALLY FIXED — Verifier tool-access shipped, but efficacy is tool-matched and unverified here.** `verifyAndRevise` now runs at the run's depth with hosted tools on the `deep` tier (api-mode judge required). Mechanism validated live. **But on gpqa-18 (a numeric abundance calculation) the tool-enabled verifier with a Gemini api judge still PASSed the wrong answer** (`passed=true, revised=false`, picked C, gold A). Root cause: gpqa-18 needs **code execution**, and our **Google integration only provides `googleSearch` (no code interpreter)** — web search is the wrong tool for a calculation. The **Anthropic api** deep tier *does* add `code_execution` (+`web_fetch`), but there's no `ANTHROPIC_API_KEY` on this machine to test it. **Follow-ups:** (a) test the verifier with an Anthropic api judge (code execution) on the calc-bound items; (b) strengthen the verifier prompt to *recompute* quantitative claims via code rather than re-reason them (the panel got it wrong by reasoning).
3. **Confident-wrong consensus** — the judge trusted a wrong Opus at influence 0.97 (item 18). The online SME loop would learn this, but it's off during benchmarks; consider confidence calibration. *(Open.)*
4. **Usage `$` is unmetered for everything on this setup** — only Gemini is API-billed and it has **no cost metadata** in the registry, so dollar figures read as 0/unmetered. Add `costPer1MIn/Out` for `gemini-3.5-flash` (and `gpt-5.5`) if a real $ number is wanted. *(Open.)*
5. ✅ **FIXED — Subscription panelists ran the session default, not their declared model.** The CLI specs never passed `--model`, so `claude -p`/`codex exec` answered on whatever the logged-in session defaulted to — a panelist declared `claude-opus-4-8` could silently run Sonnet (the suspected cause of the under-driven subscription-Opus path, next-step #5). Now each CLI is pinned via `--model`/`-m`; the Anthropic panelist self-reports as Opus 4.8. **Re-benchmark: prior numbers (fusion-deep 87.5%) predate this fix and likely understated the Opus baseline/panelist.**

6. ⚠️ **`run.mjs` MCQ grader is broken (and corrupted every prior GPQA number).** `pickLetter` takes the *first* A–H letter, grabbing letters from the reasoning; it differentially understates verbose answers (fusion synthesis ≫ terse singles). Old vs fixed grader on identical answers: 73.2% vs 92.6%, disagree 23.5%. The new `judge-eval.mjs` grades on a `FINAL ANSWER: <letter>` line (last occurrence) — **backport that to `run.mjs`** before using it again, and re-grade/disregard all pre-2026-06-26 GPQA results.

> **Tool-enabled verification needs an api-mode judge.** On this machine the judge is subscription `claude-opus-4-8`, whose CLI ignores depth/tool flags — so the deep-tier verifier won't actually search/execute unless you set an api-mode judge (only `GOOGLE_API_KEY` is present here ⇒ `--judge gemini-2.5-pro`/`gemini-3.5-flash`). To make tool-enabled verification the default, run the Anthropic judge in api mode (set `ANTHROPIC_API_KEY` + `providerAuth.anthropic = "api"`).

---

## Recommended next steps (prioritized)

1. ✅ **DONE — Tool-enabled verifier (deep tier).** `verifyAndRevise` now uses web search / code execution at `deep` depth (api-mode judge required). → `techniques.ts` `tools` flag, wired in `fusion.ts`.
2. ✅ **DONE — Retry subscription-CLI errors.** One retry in `providers/cli.ts` (engine) + one in the harness baseline.
3. 🟡 **Ablate the techniques (harness ready).** Per-technique systems shipped: `fusion-refine|-debate|-pairwise|-confidence|-sc|-verify` plus `--depth`. Still TODO: actually run the ablation on items 11–20 and set the `deep` preset to only what pays for its latency. **Re-run now that model pinning (#5) changed the baseline.**
4. **Fairer, larger GPQA run for a citable number.** Baselines now run at the right model (#5 fixed); next drive baselines at comparable reasoning depth, then run a bigger slice (e.g. 50–198) for a GPQA-D number comparable to Sakana Fugu's 95.5. (A pinned re-run of 11–18 is in `scripts/bench/data/out-pinned-11-18.json`.)
5. ✅ **DONE (root cause) — `claude -p` ran the wrong model.** Was the session default, not the declared model; now pinned via `--model`. Further depth tuning (think/effort triggers in the prompt) is still possible upside but the headline gap is closed.
6. **Multi-scope decomposition (phase 2).** Adjudicator splits a request into sub-scopes, each its own cross-model panel, then a meta-aggregator. Data model already structured for it.
7. **Derive personas from SME.** Once a model is consistently dominant in a subject, promote it into a named role — the "personas later" plan from the vision.
8. **era-code provisioning + governance.** Wire the `provisionFusion()` step into `~/era-code` (recipe in `../PUBLISHING.md`); bootstrap `.era/memory` governance for this repo per house rules.

---

## Quick reference

- Engine flow & techniques: `../fusion-flow.html`
- Setup + provider keys: `../ENGINEER_ONBOARDING.md`
- Publishing + era-code integration: `../PUBLISHING.md`
- Benchmark usage: `scripts/bench/README.md`
- Full project narrative + research: `WORKBOOK.md`
- **Security:** a Hugging Face token was shared in chat to fetch GPQA — it should be rotated; never commit keys (`.env`, `.era-fusion/`, `release/`, `scripts/bench/data/` are gitignored).
