---
description: Run a request through LLM Fusion Lite (multi-model panel + influence-weighted synthesis). Usage: /fuse <request>
---

Use the `fuse` skill to answer the following request via multi-model fusion. Run `fusion-lite-run "<request>"` (on PATH; otherwise `bash ~/.claude/skills/fuse/scripts/fuse-run.sh "<request>"`), then present the result per the skill's instructions (the service backend already synthesizes; in CLI-fallback you synthesize the panelist outputs yourself). If it reports `[llm-fusion-lite: unavailable]`, offer to set it up: `npm i -g llm-fusion-lite` then `fusion-lite setup`.

Request: $ARGUMENTS
