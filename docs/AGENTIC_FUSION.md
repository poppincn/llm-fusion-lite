# Agentic Fusion — sandboxed tool-using panelists (design)

**Status:** scaffold **validated** (2026-06-28). A Gemini agent in the sandbox autonomously ran a shell tool to compute a
SHA-256 it couldn't know from memory and returned the exact digest — proving end-to-end tool execution in isolation.
Engine integration (`sandboxed-agent` mode) is next. Subscription-CLI auth needs a one-time in-container login (below).

### Validated findings (from bring-up)
- **Image works:** real Claude Code 2.1.195 + codex 0.142.3 + gemini-cli + python in one disposable container (2.6 GB).
  Claude Code inits with `bypassPermissions` and the full tool suite (Bash/Read/Write/WebSearch/WebFetch) in `/work`.
- **Don't mount creds read-only:** the CLIs need a writable `~/.claude` (`EROFS …mkdir session-env` otherwise).
- **macOS subscription auth can't be mounted:** the OAuth token lives in the host **Keychain**, not `~/.claude.json`, so
  file mounts don't carry it. Solution: `sandbox/run.sh login` runs the device-code OAuth *inside* the container (approve
  the URL on your host browser). Persist it across `down` with a named volume on `~/.claude`/`~/.codex` (the image
  pre-chowns those dirs to the `agent` user so a fresh volume inherits write access — TODO when we add persistence).
- **API-mode keys** are passed from `~/.era-fusion/.env` via `--env-file` (don't rely on the host shell env — the key
  lives in the file). Gemini also needs `GEMINI_CLI_TRUST_WORKSPACE=true` to run tools headlessly in an untrusted dir.

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
