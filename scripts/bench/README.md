# Era Fusion benchmark harness

Put real numbers behind "fusion beats frontier": run a dataset through **era-fusion** and through each **single baseline model**, grade every answer, and print a scorecard (mean score, fusion-vs-best delta, latency, cost).

## Run

```bash
npm run build:core                                   # ensure packages/core/dist is current
node scripts/bench/run.mjs scripts/bench/sample.jsonl            # all available models + fusion
node scripts/bench/run.mjs data.jsonl --systems fusion,claude-opus-4-8,gpt-5.5 --limit 20
node scripts/bench/run.mjs data.jsonl --dry-run                  # validate dataset + systems, no API calls
```

Flags: `--systems <csv>` (default: `fusion` + every available model) · `--judge <id>` · `--offset <n>` · `--limit <n>` · `--panel <csv>` (force fusion's panel) · `--depth <light|standard|deep>` (force the depth tier for fusion systems) · `--out <file>`.

Needs provider keys/subscriptions configured (`fuse doctor`). Cost: each item runs once per system, plus an LLM-judge call for judged items — so ≈ `(systems + 1) × items` model calls. Start with `--limit`.

## Technique ablation

Each fusion technique can be run in isolation as its own system, so you can see which ones actually pay for their latency before fixing the `deep` preset. Every preset is a *full* `TechniqueConfig`, so it fully determines what runs regardless of the depth tier:

| system | what runs |
| --- | --- |
| `fusion` | base pipeline (fan-out → synthesize) |
| `fusion-refine` | + MoA refinement only |
| `fusion-debate` | + MoA refinement with explicit disagreement resolution |
| `fusion-pairwise` | + pairwise ranking → judge weights only |
| `fusion-confidence` | + panelist self-confidence only |
| `fusion-sc` | + self-consistency (2 synthesis samples) only |
| `fusion-verify` | + post-synthesis verify/revise only |
| `fusion-deep` | everything on |

```bash
node scripts/bench/run.mjs data.jsonl --depth deep \
  --systems fusion,fusion-refine,fusion-pairwise,fusion-sc,fusion-verify,fusion-deep
```

> The **tool-enabled verifier** (web search + code execution at `deep` depth) only engages when the judge runs in **api** mode — subscription CLIs ignore the depth/tool flags. To ablate it with tools live, pass an api-mode judge, e.g. `--judge gemini-2.5-pro`.

## Judge comparison (paired, variance-controlled) — `judge-eval.mjs`

`run.mjs` re-queries the panel every run, and those answers swing **±6–12 pts run-to-run** (subscription models are non-deterministic). That noise dwarfs the effect of swapping the judge, so comparing judges across separate `run.mjs` runs is unreliable. `judge-eval.mjs` fixes this with a **paired (blocked) design**:

1. **`snapshot`** — query the panel once and **cache** the answers to disk.
2. **`judges`** — cross **every** candidate judge over the **identical** cached panels, with `k` repeated judge samples. Panel noise is differenced out, so any accuracy gap is the judge (± judge sampling noise). The cache also yields each single model's and the panel's **majority-vote** accuracy for free.

```bash
# Phase 1 — snapshot 50 items once (reusable; the expensive part):
node scripts/bench/judge-eval.mjs snapshot scripts/bench/data/gpqa_diamond.jsonl \
  --panel claude-opus-4-8,gpt-5.5,gemini-3.5-flash --offset 0 --limit 50 \
  --depth standard --k-panel 1 --out scripts/bench/data/panels-50.json

# Phase 2 — cross judges over the cache (cheap; rerun anytime, add judges later):
node scripts/bench/judge-eval.mjs judges scripts/bench/data/panels-50.json \
  --judges claude-opus-4-8,gpt-5.5,gemini-2.5-pro,gemini-3.5-flash --k-judge 3 \
  --out scripts/bench/data/judges-50.json
```

Output: per-judge accuracy with **bootstrap 95% CIs**, **paired diffs** vs the best judge (flags when a CI excludes 0 = significant), and the single-model / majority-vote baselines. Objective (letter-answer) datasets only — grading must be deterministic. Grading parses a `FINAL ANSWER: X` line (last occurrence) so verbose syntheses aren't mis-scored. **Add a judge later** (e.g. a Baseten model, see `docs/ENGINEER_ONBOARDING.md`) and just rerun Phase 2 against the same cache — directly comparable, no panel re-run.

## Dataset format (JSONL)

```jsonc
// Objective — graded by exact/letter match (free, deterministic):
{ "id": "q1", "prompt": "…answer with the letter only", "choices": ["…"], "answer": "B" }
// Judged — graded 0–100 by the judge model against a rubric:
{ "id": "q2", "prompt": "…", "rubric": "what a correct, complete answer must contain" }
```

`sample.jsonl` has two of each as a smoke test.

## Plugging in standard benchmarks

- **GPQA-Diamond** (what Fugu reports, 95.5): convert each question to an objective MCQ row (`choices` + `answer` letter). 198 items → objective, deterministic grading.
- **Humanity's Last Exam / open research (DRACO-style)**: use judged rows with a strong rubric per item; set `--judge` to your most capable model and exclude it from `--systems` to avoid self-grading bias.
- **SWE-Bench Pro / LiveCodeBench**: these need an *execution* harness (apply patch, run tests) — out of scope for this grader; wire `run.mjs`'s grading step to a runner that executes and checks pass/fail.

## Notes & caveats

- Fusion runs with `noLearn: true` so benchmarking doesn't pollute the adaptive store.
- **Judge bias:** don't use the same model as both a baseline system and the judge on judged items, or it will favor its own style. Prefer objective datasets for headline numbers; use judged mode for directional signal.
- Results JSON includes per-item, per-system score/latency/cost for analysis.
- Subscription models report estimated tokens and unmetered cost (shown as `unmetered`).
