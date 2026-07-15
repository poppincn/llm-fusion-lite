---
description: Run a request through Era Fusion (multi-model panel + influence-weighted synthesis). Usage: /fuse <request>
---

Use the `fuse` skill to answer the following request via multi-model fusion. Run `fuse-run "<request>"` (on PATH; otherwise `bash ~/.claude/skills/fuse/scripts/fuse-run.sh "<request>"`), then present the result per the skill's instructions (the service backend already synthesizes; in CLI-fallback you synthesize the panelist outputs yourself). If it reports `[era-fusion: unavailable]`, offer to set it up: `npm i -g @alexanderollman/llm-fusion` then `fuse setup`.

Request: $ARGUMENTS
