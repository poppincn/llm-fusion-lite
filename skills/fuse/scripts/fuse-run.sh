#!/usr/bin/env bash
# LLM Fusion Lite orchestrator for agentic harnesses (Claude Code / OpenCode).
# Service-first: use the `fusion-lite` engine when provider keys are configured.
# Lazy provision: if keys exist but the engine isn't installed, run it on
# demand via npx (cached after first use).
# CLI fallback: otherwise (or if the engine fails) fan the same prompt out to
# available model CLIs — in PARALLEL — and let the host agent synthesize.
# Prints a backend marker on the first line.
set -uo pipefail

PKG="llm-fusion-lite"
ENV_FILE="${LLM_FUSION_LITE_HOME:-$HOME/.llm-fusion-lite}/.env"

REQUEST="${*:-}"
if [ -z "$REQUEST" ] && [ ! -t 0 ]; then
  REQUEST="$(cat)"
fi
if [ -z "$REQUEST" ]; then
  echo "[llm-fusion-lite: unavailable]"
  echo "No request provided."
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

# A provider key counts as present if exported, or persisted in ~/.llm-fusion-lite/.env.
keys_present() {
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && return 0
  done
  [ -f "$ENV_FILE" ] && grep -qE '^[[:space:]]*(ANTHROPIC|OPENAI|GOOGLE|GEMINI)_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$ENV_FILE" && return 0
  return 1
}

# Resolve a runnable `fusion-lite`: prefer PATH, else lazy-provision via npx (cached).
resolve_fuse() {
  if have fusion-lite; then echo "fusion-lite"; return 0; fi
  if have npx; then echo "npx -y -p $PKG fusion-lite"; return 0; fi
  return 1
}

# Any subscription CLI on PATH also makes the engine worth attempting (a
# provider may be configured for subscription mode with no API key set).
clis_present() {
  have codex || have gemini || have claude
}

# --- CLI fallback: fan out the same prompt to installed model CLIs, in parallel.
# Defined before the service path so the service path can fall back to it on
# engine failure. Each panelist is a distinct binary, so they run concurrently
# (wall-clock = slowest panelist, not the sum). Output for each lands as soon as
# that panelist finishes rather than only when the whole run completes.
run_panelist() {
  case "$1" in
    codex)  codex exec "$REQUEST" 2>/dev/null ;;
    gemini) gemini -p "$REQUEST" 2>/dev/null ;;
    claude) claude -p "$REQUEST" 2>/dev/null ;;
  esac
}

cli_fallback() {
  local PANELISTS=()
  have codex && PANELISTS+=("codex")
  have gemini && PANELISTS+=("gemini")
  have claude && PANELISTS+=("claude")

  if [ "${#PANELISTS[@]}" -eq 0 ]; then
    echo "[llm-fusion-lite: unavailable]"
    echo "No provider API keys and no model CLIs (codex/gemini/claude) found."
    echo "Set up LLM Fusion Lite:  npm i -g $PKG  &&  fusion-lite setup   (guided key entry)"
    echo "Or run 'fusion-lite doctor' for guidance."
    return 1
  fi

  echo "[llm-fusion-lite: cli-fallback]"
  echo "Panel: ${PANELISTS[*]} — same prompt run in parallel. Synthesize these into one best answer."
  echo

  local tmpdir
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/llm-fusion-lite.XXXXXX")"

  # Launch every panelist concurrently; capture stdout + exit code per panelist.
  local i=0
  for p in "${PANELISTS[@]}"; do
    ( run_panelist "$p" >"$tmpdir/$i.out" 2>/dev/null; echo $? >"$tmpdir/$i.rc" ) &
    i=$((i + 1))
  done
  local total=$i

  # Surface each panelist as it completes (panel order), so the run shows
  # progress instead of appearing stuck until every panelist finishes.
  local printed=0
  local shown=()
  while [ "$printed" -lt "$total" ]; do
    local progressed=0 j=0
    for p in "${PANELISTS[@]}"; do
      if [ -z "${shown[$j]:-}" ] && [ -f "$tmpdir/$j.rc" ]; then
        shown[$j]=1
        printed=$((printed + 1))
        progressed=1
        local rc out
        rc="$(cat "$tmpdir/$j.rc" 2>/dev/null || echo 1)"
        out="$(cat "$tmpdir/$j.out" 2>/dev/null || true)"
        echo "=== panelist: $p ==="
        if [ -n "$out" ]; then
          echo "$out"
        elif [ "$rc" = "0" ]; then
          echo "(no output — $p returned nothing)"
        else
          echo "(skipped — $p errored or is unauthenticated; exit $rc. Try '$p' interactively to check its login.)"
        fi
        echo
      fi
      j=$((j + 1))
    done
    [ "$printed" -lt "$total" ] && [ "$progressed" -eq 0 ] && sleep 1
  done
  wait
  rm -rf "$tmpdir"
  return 0
}

# --- Service backend: full engine + adaptive learning (lazy-provisioned) -----
# If `fusion-lite` is installed, trust `fusion-lite config` to report readiness — it counts
# subscription providers (CLI on PATH) as configured, not just API keys. Only
# fall back to the keys/CLIs heuristic when deciding whether to lazy-provision
# via npx (we don't want to pull the package for an empty environment).
#
# On engine FAILURE (non-zero exit — e.g. a credential-preflight stop), degrade
# to the parallel CLI fan-out instead of dying, so the user still gets an answer
# when local CLIs are available.
if have fusion-lite; then
  if ! fusion-lite config 2>/dev/null | grep -q "providers configured: none"; then
    echo "[llm-fusion-lite: service]"
    if fusion-lite "$REQUEST"; then
      exit 0
    fi
    echo "[llm-fusion-lite: service backend failed — falling back to parallel CLI panelists]" >&2
    cli_fallback
    exit $?
  fi
elif keys_present || clis_present; then
  if FUSE_CMD="$(resolve_fuse)"; then
    if ! $FUSE_CMD config 2>/dev/null | grep -q "providers configured: none"; then
      echo "[llm-fusion-lite: service]"
      if $FUSE_CMD "$REQUEST"; then
        exit 0
      fi
      echo "[llm-fusion-lite: service backend failed — falling back to parallel CLI panelists]" >&2
      cli_fallback
      exit $?
    fi
  else
    echo "[llm-fusion-lite: unavailable]"
    echo "Providers found, but LLM Fusion Lite isn't installed and npx is unavailable."
    echo "Install: npm i -g $PKG   (then re-run)."
    exit 1
  fi
fi

# --- No configured service backend: go straight to the parallel CLI fan-out. --
cli_fallback
exit $?
