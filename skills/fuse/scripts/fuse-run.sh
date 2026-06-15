#!/usr/bin/env bash
# Era Fusion orchestrator for agentic harnesses (Claude Code / OpenCode).
# Service-first: use the `fuse` engine when provider keys are configured.
# CLI fallback: otherwise fan the same prompt out to available model CLIs and
# let the host agent synthesize. Prints a backend marker on the first line.
set -uo pipefail

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

# --- Service backend: full engine + adaptive learning -----------------------
if have fuse; then
  if ! fuse config 2>/dev/null | grep -q "providers configured: none"; then
    echo "[era-fusion: service]"
    fuse "$REQUEST"
    exit $?
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
  echo "Run 'fuse doctor' for guidance."
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
