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

## Findings: tools fix computation, not concepts (2026-06-28)

A/B on **gpqa-18** (the calc item that defeated the non-agentic panel + tool-blind verifier):

- **Non-agentic:** Claude reasoned in its head, picked **C** (wrong; gold A). Used no tools.
- **Agentic, no nudge:** Claude *still* used no tools, picked C. (Agentic mode doesn't force tool use.)
- **Agentic + Lever 1 (force-compute nudge):** Claude now used **Bash** ✅ — the nudge demonstrably changed behavior —
  but still picked **C**.
- **Agentic + Lever 1 + Lever 2 (tool-using judge, Claude *and* Gemini judge variants):** still **C**.

**Conclusion:** gpqa-18's failure is **conceptual** (wrong physics setup), not arithmetic — so tool execution and
independent re-computation can't fix it (the agent computed the *wrong formula* correctly). Contrast `73^19`, a pure
*computational* task, where the same agentic path got it exactly right. **Agentic tools fix computation and lookup
errors; they do not fix domain-reasoning errors.** gpqa-18 was the wrong item to prove tool value. To *measure* the
levers, A/B on tool-sensitive items whose failure mode is computational/factual (not conceptual).

Both levers are implemented and Lever 1 is verified to change behavior (Claude `tools=[-]` → `tools=[Bash]`). Cost: an
agentic fusion item ran **~$0.06–0.09** (Opus agent dominant; rises when it actually executes tools). Open artifact: in
the lever run the Gemini panelist's answer didn't parse to a letter (`pick=?`) — agentic gemini-cli output formatting to
investigate.

## Result: tools give a clean +30 pts on computational tasks (2026-06-28)

The fair A/B (same genuinely-tool-free model, same items, tools the only variable) on the 10-item exact-computation set:

| gemini-3.5-flash | accuracy | misses |
| --- | --- | --- |
| tool-free (api) | 70% | 89^17, 7^131 mod p, C(80,23) — the big-integer ones |
| **agentic (sandbox)** | **100%** | none |

**+30 pts, to a perfect score** — the agent ran `python3` to compute exactly what it failed mentally. This is the test
gpqa-18 wasn't: when the failure mode is *computational*, the shared toolset is decisive; when it's *conceptual*
(gpqa-18), tools don't help. Net characterization: **agentic tools fix computation and lookup, not domain reasoning** —
so route quantitative/factual work through agents, and invest elsewhere (judge, panel quality) for reasoning.

## Finding: subscription CLIs were never a tool-free baseline (2026-06-28)

Running the exact-computation benchmark **non-agentically**, `claude-opus-4-8` scored **100%** — it cannot compute
`89^17` or the 7000th prime from memory, so the host `claude` CLI **was using tools**. It is the full Claude Code agent
with `--dangerously-skip-permissions`; even what the engine treats as a "plain completion" runs an agent loop with host
bash. So **every prior benchmark that used subscription Claude/Codex panelists already had uncontrolled host-tool
access** — it just rarely mattered on closed-book GPQA, and is invisible/unsandboxed. The only *genuinely* tool-free
panelist on this setup is an **api-mode** model (e.g. Gemini api: **50%** on the same items). Implication: clean
"tools-on vs tools-off" A/Bs must use api-mode models for the tool-free arm (or route everything through the sandbox so
tool access is at least *controlled and observable*). It also strengthens the case for the sandbox: it turns this
accidental host-tool access into deliberate, contained, uniform tooling.

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
