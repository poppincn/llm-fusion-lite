#!/usr/bin/env bash
# Era Fusion orchestrator for agentic harnesses (Claude Code / OpenCode).
# Service-first: use the `fuse` engine when provider keys are configured.
# Lazy provision: if keys exist but the engine isn't installed, run it on
# demand via npx (cached after first use).
# CLI fallback: otherwise fan the same prompt out to available model CLIs and
# let the host agent synthesize. Prints a backend marker on the first line.
set -uo pipefail

PKG="@alexanderollman/llm-fusion"
ENV_FILE="${ERA_FUSION_HOME:-$HOME/.era-fusion}/.env"

REQUEST="${*:-}"
if [ -z "$REQUEST" ] && [ ! -t 0 ]; then
  REQUEST="$(cat)"
fi
if [ -z "$REQUEST" ]; then
  echo "[era-fusion: unavailable]"
  echo "No request provided."
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

# A provider key counts as present if exported, or persisted in ~/.era-fusion/.env.
keys_present() {
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GEMINI_API_KEY; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && return 0
  done
  [ -f "$ENV_FILE" ] && grep -qE '^[[:space:]]*(ANTHROPIC|OPENAI|GOOGLE|GEMINI)_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$ENV_FILE" && return 0
  return 1
}

# Resolve a runnable `fuse`: prefer PATH, else lazy-provision via npx (cached).
resolve_fuse() {
  if have fuse; then echo "fuse"; return 0; fi
  if have npx; then echo "npx -y -p $PKG fuse"; return 0; fi
  return 1
}

# Any subscription CLI on PATH also makes the engine worth attempting (a
# provider may be configured for subscription mode with no API key set).
clis_present() {
  have codex || have gemini || have claude
}

# --- Service backend: full engine + adaptive learning (lazy-provisioned) -----
# If `fuse` is installed, trust `fuse config` to report readiness — it now counts
# subscription providers (CLI on PATH) as configured, not just API keys. Only
# fall back to the keys/CLIs heuristic when deciding whether to lazy-provision
# via npx (we don't want to pull the package for an empty environment).
if have fuse; then
  if ! fuse config 2>/dev/null | grep -q "providers configured: none"; then
    echo "[era-fusion: service]"
    fuse "$REQUEST"
    exit $?
  fi
elif keys_present || clis_present; then
  if FUSE_CMD="$(resolve_fuse)"; then
    if ! $FUSE_CMD config 2>/dev/null | grep -q "providers configured: none"; then
      echo "[era-fusion: service]"
      $FUSE_CMD "$REQUEST"
      exit $?
    fi
  else
    echo "[era-fusion: unavailable]"
    echo "Providers found, but Era Fusion isn't installed and npx is unavailable."
    echo "Install: npm i -g $PKG   (then re-run)."
    exit 1
  fi
fi

# --- CLI fallback: fan out the same prompt to installed model CLIs -----------
PANELISTS=()
have codex && PANELISTS+=("codex")
have gemini && PANELISTS+=("gemini")
have claude && PANELISTS+=("claude")

if [ "${#PANELISTS[@]}" -eq 0 ]; then
  echo "[era-fusion: unavailable]"
  echo "No provider API keys and no model CLIs (codex/gemini/claude) found."
  echo "Set up Era Fusion:  npm i -g $PKG  &&  fuse setup   (guided key entry)"
  echo "Or run 'fuse doctor' for guidance."
  exit 1
fi

echo "[era-fusion: cli-fallback]"
echo "Panel: ${PANELISTS[*]} — same prompt run independently. Synthesize these into one best answer."
echo

run_panelist() {
  case "$1" in
    codex)  codex exec "$REQUEST" 2>/dev/null ;;
    gemini) gemini -p "$REQUEST" 2>/dev/null ;;
    claude) claude -p "$REQUEST" 2>/dev/null ;;
  esac
}

for p in "${PANELISTS[@]}"; do
  echo "=== panelist: $p ==="
  out="$(run_panelist "$p")"
  if [ -z "$out" ]; then
    echo "(no output — $p unavailable or errored)"
  else
    echo "$out"
  fi
  echo
done
