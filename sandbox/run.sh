#!/usr/bin/env bash
# Era Fusion agentic sandbox — build / start / smoke-test the disposable container
# in which panelists run as full tool-using agents. See docs/AGENTIC_FUSION.md.
#
#   sandbox/run.sh build   # build the image (CLIs + runtimes + MCP)
#   sandbox/run.sh up      # start the long-lived sandbox (mounts creds read-only)
#   sandbox/run.sh smoke   # run a claude panelist that MUST use a tool (proves execution)
#   sandbox/run.sh exec ... # run an arbitrary command in the sandbox
#   sandbox/run.sh down    # stop + remove the sandbox
set -euo pipefail

IMAGE="era-fusion-sandbox"
NAME="era-fusion-sandbox"
HERE="$(cd "$(dirname "$0")" && pwd)"

need_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not running. Start Docker Desktop (or 'colima start') and retry." >&2
    exit 1
  fi
}

case "${1:-}" in
  build)
    need_docker
    docker build -t "$IMAGE" "$HERE"
    ;;
  up)
    need_docker
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # Mount subscription creds READ-ONLY for plan auth; pass any API keys as env.
    # No host repo is mounted — agents only see /work and /cfg.
    docker run -d --name "$NAME" \
      -v "$HOME/.claude:/home/agent/.claude:ro" \
      -v "$HOME/.claude.json:/home/agent/.claude.json:ro" \
      -v "$HOME/.codex:/home/agent/.codex:ro" \
      -v "$HERE/mcp.json:/cfg/mcp.json:ro" \
      -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e GOOGLE_API_KEY -e GEMINI_API_KEY -e BASETEN_API_KEY \
      "$IMAGE" >/dev/null
    echo "Sandbox '$NAME' up. Verify CLIs:"
    docker exec "$NAME" bash -lc 'claude --version; codex --version; python3 --version'
    ;;
  smoke)
    need_docker
    # A task that can't be answered reliably from memory → forces a tool (bash/python).
    # Emits stream-json; we grep host-side for tool_use events + the final result.
    RUNID="smoke-$(date +%s)"
    PROMPT='Using a tool, compute the SHA-256 hex digest of the exact string fusion-era-2026, then output only: FINAL ANSWER: <digest>'
    docker exec "$NAME" bash -lc "mkdir -p /work/$RUNID && cd /work/$RUNID && claude -p --model claude-opus-4-8 --permission-mode bypassPermissions --output-format stream-json --verbose \"\$1\"" _ "$PROMPT" \
      | tee /tmp/era-smoke.jsonl \
      | jq -rc 'if .type=="assistant" then (.message.content[]? | select(.type=="tool_use") | "TOOL_USE: "+.name) elif .type=="result" then "RESULT: "+(.result//"") else empty end' || cat /tmp/era-smoke.jsonl
    echo "--- expect one or more TOOL_USE lines (e.g. Bash), then RESULT with the digest ---"
    ;;
  exec)
    need_docker; shift
    docker exec -i "$NAME" bash -lc "$*"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "not running"
    ;;
  *)
    echo "usage: sandbox/run.sh {build|up|smoke|exec <cmd>|down}" >&2
    exit 1
    ;;
esac
