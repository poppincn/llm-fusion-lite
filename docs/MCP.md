# Era Fusion as an MCP tool

Give any MCP-capable agentic coding stack a **`fuse`** tool — multi-model consensus on demand. The agent calls it when *it*
judges a problem warrants a council (architecture, planning, deep research, gnarly debugging); it should **not** be used
for trivial turns (it's slower and more expensive than a single model — that's the point).

The server runs the engine **in-process** with your local `~/.era-fusion` config and keys, so it learns per-subject model
strengths over time and, in `agentic` mode, uses your **local sandbox** (your Docker, your keys — nothing leaves your
machine except the model API calls you already make).

## Prerequisites

1. Provider keys in `~/.era-fusion/.env` (or a configured subscription) — run `fuse doctor` to check.
2. For `agentic: true` only: the sandbox container running — `sandbox/run.sh up` (see [AGENTIC_FUSION.md](AGENTIC_FUSION.md)).

## Install

The server is the `fuse-mcp` bin on the published package, so no separate install — your MCP client launches it via `npx`.

### Claude Code
```bash
claude mcp add era-fusion -- npx -y @alexanderollman/llm-fusion fuse-mcp
```
or in `.mcp.json` / `~/.claude.json`:
```json
{ "mcpServers": { "era-fusion": { "command": "npx", "args": ["-y", "@alexanderollman/llm-fusion", "fuse-mcp"] } } }
```

### Codex (`~/.codex/config.toml`)
```toml
[mcp_servers.era-fusion]
command = "npx"
args = ["-y", "@alexanderollman/llm-fusion", "fuse-mcp"]
```

### Cursor / Windsurf / Zed / Continue (`mcp.json`)
```json
{ "mcpServers": { "era-fusion": { "command": "npx", "args": ["-y", "@alexanderollman/llm-fusion", "fuse-mcp"] } } }
```

> Developing locally? Point `command`/`args` at the workspace build instead:
> `"command": "node", "args": ["<repo>/packages/cli/dist/mcp.js"]`.

## The `fuse` tool

| arg | type | notes |
| --- | --- | --- |
| `prompt` | string (required) | the question/task; include the context the panel needs |
| `depth` | `light\|standard\|deep` | omit to auto-select; `deep` enables all techniques |
| `agentic` | boolean | run panelists as sandboxed tool-using agents (computation / current info) |
| `panel` | string[] | explicit model ids (else adaptive selection) |
| `judge` | string | judge/synthesizer model id (else default) |

Returns the synthesized answer, prefixed with a one-line header (`[fusion · <subject> · depth … · panel … · judge …]`).

### Telling the agent when to reach for it
Add a line to your project's agent instructions (e.g. `CLAUDE.md` / `AGENTS.md`):

> For high-stakes architecture decisions, ambiguous trade-offs, or after two failed attempts at a hard bug, call the
> `fuse` MCP tool to get multi-model consensus before proceeding. Don't use it for routine edits.
