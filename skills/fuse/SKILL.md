---
name: fuse
description: Run a request through Era Fusion — dispatch it to a panel of multiple AI models in parallel, then synthesize one best answer with an influence-weighted judge. Use for high-stakes, ambiguous, or research-heavy questions where multi-model consensus beats a single model, or when the user says "fuse this", "run through fusion", or invokes /fuse. Learns each model's per-subject strengths over time.
---

# Fusion

Era Fusion answers a request by running it across **multiple models in parallel** and synthesizing their outputs into a single best answer. Diversity is *harvested* (the same prompt to different models yields different reasoning, tools, and sources), not manufactured. A judge model then produces a structured comparison (consensus, contradictions, gaps, unique insights) and an **influence-weighted** final answer, and the system records which model influenced the answer most for this subject — building per-model subject-matter expertise over time.

## When to use
- The user explicitly asks to "fuse", "run through fusion", or uses `/fuse`.
- High-stakes or ambiguous questions where a confident single-model error is costly.
- Research / comparison / design / debugging tasks that benefit from multiple independent attempts.

Skip it for trivial lookups or when the user wants a single quick answer.

## How to run it

Run the orchestrator with the user's request. It picks the best available backend automatically:

```bash
fuse-run "<the user's full request>"
```

(`fuse-run` is installed on PATH by the setup script. If it isn't found, run the bundled copy: `bash ~/.claude/skills/fuse/scripts/fuse-run.sh "<request>"`, or `bash <this skill dir>/scripts/fuse-run.sh "<request>"`.)

The script prints a marker on its first line telling you which backend ran:

### `[era-fusion: service]`
The full Era Fusion engine ran (provider API keys present). What follows on stdout **is the final synthesized answer** — it already incorporates the panel, the influence-weighted judge, and learned subject expertise, and the run was recorded for learning. Present this answer to the user as the result. The trailing `— run <id> …` line carries the run id; tell the user they can rate it with `fuse feedback <id> up|down` to improve future model selection.

### `[era-fusion: cli-fallback]`
No API keys were configured, so the script fanned the **same prompt** out to whatever model CLIs are installed (`codex`, `gemini`, `claude`) and printed each panelist's raw response in labeled `=== panelist: <name> ===` blocks. **You are now the judge.** Read every panelist block, then:
1. Produce a brief structured comparison: **consensus** (what they agree on), **contradictions** (where they disagree — resolve in favor of the better-supported claim), **unique insights** (correct points only one raised), and **blind spots/gaps**.
2. Write the single best final answer, grounded in the strongest correct material across panelists. Don't mention the panel or that this is a synthesis unless the user asks — just give an excellent answer.

### `[era-fusion: unavailable]`
Neither API keys nor model CLIs are available. Tell the user to run `fuse doctor`, then set `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY` / `GOOGLE_API_KEY`) or install the `codex` / `gemini` CLIs. Offer to answer directly as a single model instead.

## Notes
- The script may take a while on deep requests — the engine scales panelist depth to the scope of the request (light → standard → agentic deep research).
- Never fabricate panelist outputs. If a backend fails, report what actually happened.
- Setup / health check: `fuse doctor`. Learned strengths: `fuse stats [subject]`.
