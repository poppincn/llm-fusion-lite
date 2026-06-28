# Agentic Fusion — sandboxed tool-using panelists (design)

**Status:** **working end-to-end** (2026-06-28). All three agent paths (Claude/Gemini/Codex) authenticate via API keys and
execute tools in the sandbox, and the **engine integration is wired**: `fuse({agentic:true})` / `fuse --agentic` /
`run.mjs --agentic` route panelists through the sandbox, capture their tool calls, and synthesize. Validated: agentic
fusion computed `73^19` exactly (Claude panel used `Bash` — tool call captured; judge synthesized the 36-digit answer).
Next: surface `toolCalls` in the UI/usage, A/B agentic-vs-not on tool-sensitive items, parse gemini/codex tool events,
and phase-2 parity for api/Baseten models via a function-calling loop.

### Validated findings (from bring-up)
- **Image works:** real Claude Code 2.1.195 + codex 0.142.3 + gemini-cli + python in one disposable container (2.6 GB).
  Claude Code inits with `bypassPermissions` and the full tool suite (Bash/Read/Write/WebSearch/WebFetch) in `/work`.
- **Don't mount creds read-only:** the CLIs need a writable `~/.claude` (`EROFS …mkdir session-env` otherwise).
- **macOS subscription auth can't be mounted:** the OAuth token lives in the host **Keychain**, not `~/.claude.json`, so
  file mounts don't carry it. Solution: `sandbox/run.sh login` runs the device-code OAuth *inside* the container (approve
  the URL on your host browser). Persist it across `down` with a named volume on `~/.claude`/`~/.codex` (the image
  pre-chowns those dirs to the `agent` user so a fresh volume inherits write access — TODO when we add persistence).
- **API-mode keys** are passed from `~/.era-fusion/.env` via `--env-file` (don't rely on the host shell env — the key
  lives in the file). Per-agent auth recipe (all validated — each ran a tool to compute SHA-256('fusion-era-2026')):
  - **Claude** — reads `ANTHROPIC_API_KEY` directly. `claude -p --model … --permission-mode bypassPermissions
    --output-format stream-json` → emits `tool_use` events (observable) + final result. ✅ used Bash, exact digest.
  - **Gemini** — reads `GOOGLE_API_KEY`; needs `GEMINI_CLI_TRUST_WORKSPACE=true` + `--yolo` for headless tool use.
    ✅ exact digest.
  - **Codex** — does **not** read `OPENAI_API_KEY`; register once with `printenv OPENAI_API_KEY | codex login
    --with-api-key` (done automatically by `run.sh up`). `codex exec` needs `--skip-git-repo-check` outside a repo and
    `--sandbox workspace-write`. ✅ authenticated + executed tools — **but on the trivial hash it looped on web search
    instead of running `sha256sum`** (a gpt-5.5 agentic tool-choice quirk; relevant to panelist reliability, not a
    sandbox bug).
- **Observation:** tool-using agents differ in *judgment*, not just capability — Claude/Gemini reached for the obvious
  local shell; Codex over-reached to web search. The engine should capture each agent's tool calls (stream-json) so the
  judge/influence can account for tool-choice quality, and consider per-model tool allow-lists.

## Why

Today's panel is a set of *chat completions* with uneven, accidental tool access (see HANDOVER §"what tools each
panel member gets"): api-Gemini gets hosted `googleSearch`; subscription Claude/GPT run as full local agents but
**unconfigured, dormant, and in the repo CWD** (an RCE footgun the constitution forbids); Baseten gets nothing. A real
"panel of experts" should be a set of *capable agents* with the **same** controlled toolset, and it should be **safe**.

## Core idea: run the panel inside a disposable sandbox

The constitution forbids host-bash because it's RCE on the user's machine. That constraint is satisfied — not
violated — by giving agents a **throwaway VM/container** instead of the host. Inside the sandbox we can hand every
panelist **aggressive, full agentic tools** (bash, filesystem, code execution, web, MCP servers, skills) precisely
*because* the blast radius is contained and the environment is reproducible.

Benefits: (1) **safety** — agents can't touch the host; (2) **parity** — one preinstalled toolset for every panelist
regardless of provider; (3) **reproducibility** — a pinned image reduces environment variance (model sampling still
varies); (4) **observability** — capture each agent's tool calls (`--output-format stream-json`) for analysis +
influence scoring.

## Architecture

```
host:  fuse engine ── adjudicate ─┬─ panelist 1 ─ docker exec ─┐
                                  ├─ panelist 2 ─ docker exec ─┤   long-lived sandbox container
                                  └─ panelist 3 ─ docker exec ─┘   (claude-code · codex · gemini-cli ·
                                                                    python · node · MCP servers · skills)
       judge (api, on host or in sandbox) ── synthesize            each panelist in its own /work/<runid> dir
```

- **Sandbox = one long-lived container** (`era-fusion-sandbox`), engine stays on the host. Each panelist call is a
  `docker exec` into a **fresh per-call working dir** (`/work/<uuid>`), so parallel panelists don't collide and nothing
  persists between runs. Chosen over per-call ephemeral containers (too heavy) and whole-engine-in-container (worse UX).
- **Shared toolset** via a single MCP config mounted into the container (`sandbox/mcp.json`) plus the CLIs' built-in
  bash/file/web. api + Baseten models reach parity later through a provider-agnostic tool-call loop wired to the *same*
  MCP tools (phase 2).
- **Auth:** mount the host's `~/.claude`, `~/.claude.json`, `~/.codex` **read-only** into the container so the
  subscription CLIs use the user's plan; pass `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY`/`BASETEN_API_KEY`
  as env for api-mode models. (Creds are never baked into the image.)
- **Isolation level:** on macOS, Docker Desktop/Colima already runs containers inside a Linux VM, so a container here
  *is* a VM boundary from the host. For untrusted-code-grade isolation later: gVisor (`--runtime=runsc`) or a
  Firecracker microVM per panelist. Network: allow model APIs + web tools; optionally egress-filter.

## Engine integration (phase 1)

Add an **agentic execution mode** routed through the sandbox:
- New provider `sandboxed-agent` (or an `agentic: true` option on the existing `cli` path). When on, `complete()` runs
  `docker exec <container> <cli> -p --model <m> --mcp-config /cfg/mcp.json --allowedTools <set> \
  --permission-mode bypassPermissions --output-format stream-json <prompt>` in `/work/<uuid>`, reusing the existing
  per-bin lock + retry. Parse stream-json → final text + the list of tool calls made (for the result + influence).
- A new depth tier `agent` (above `deep`) selects this mode; or a per-request `--agentic` flag. Default `fuse` stays
  in the safe non-agentic path; agentic mode is explicit opt-in.
- `PanelResponse` gains `toolCalls?: {name, input}[]` so the judge/usage can see what each agent actually did.

## Benchmark (phase 3)

The current GPQA-D set is closed-book — tools barely help (94–96% already). To *measure* the agentic payoff, add
tool-sensitive sets and an A/B: same items, `--agentic` on vs off, via the snapshot/judge harness. Targets the user
chose: live research/current-events (web), quantitative/code (code-exec — e.g. the gpqa-18 calc class), coding/repo
(file+bash in sandbox), while keeping closed-book reasoning as a control.

## Open decisions

1. **Isolation level:** Docker container (fast, good on macOS via its VM) now, with a path to gVisor/Firecracker for
   untrusted-code grade — or go straight to a microVM. Recommend: **Docker now**, harden later.
2. **Auth into sandbox:** mount host creds read-only (uses subscription plans, zero extra cost) vs API-keys-only in the
   container (cleaner isolation, metered $). Recommend: **mount read-only** for dev, document the API-key option.
3. **Scope of tools in v1:** built-in bash/file/web of the CLIs + a code-exec + fetch MCP — vs a larger curated
   MCP/skill set. Recommend: **start minimal, expand**.

## Build / run (scaffold)

```bash
# 1. start Docker (daemon currently down): open Docker Desktop, or `colima start`
# 2. build the sandbox image (CLIs + runtimes + MCP):
sandbox/run.sh build
# 3. start the long-lived sandbox (mounts creds read-only, passes keys):
sandbox/run.sh up
# 4. smoke a panelist agent that must USE a tool (compute → proves tool execution):
sandbox/run.sh smoke
```
