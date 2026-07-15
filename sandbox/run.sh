#!/usr/bin/env bash
# Era Fusion agentic sandbox — build / start / smoke-test the disposable container
# in which panelists run as full tool-using agents. See docs/AGENTIC_FUSION.md.
#
#   sandbox/run.sh build           # build the image (CLIs + runtimes + MCP)
#   sandbox/run.sh up              # start the long-lived sandbox (keys from ~/.era-fusion/.env)
#   sandbox/run.sh login           # one-time interactive OAuth for subscription CLIs (claude/codex)
#   sandbox/run.sh smoke [gemini|claude|codex]  # agent that MUST use a tool (proves execution)
#   sandbox/run.sh exec <cmd...>   # run an arbitrary command in the sandbox
#   sandbox/run.sh down            # stop + remove the sandbox
#
# Auth: API-mode models read keys from ~/.era-fusion/.env (passed via --env-file).
# Subscription CLIs (claude/codex) store an OAuth token in the host Keychain on
# macOS, which can't be mounted into Linux — so log in once *inside* the container
# (`login`); it persists for the container's lifetime (use a named volume to keep
# it across `down` — see docs/AGENTIC_FUSION.md).
set -euo pipefail

IMAGE="era-fusion-sandbox"
NAME="era-fusion-sandbox"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.era-fusion/.env"

need_docker() {
  docker info >/dev/null 2>&1 || { echo "Docker daemon is not running. Start Docker Desktop (or 'colima start')." >&2; exit 1; }
}

case "${1:-}" in
  build)
    need_docker
    docker build -t "$IMAGE" "$HERE"
    ;;
  up)
    need_docker
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # No read-only cred mounts (the CLIs need a writable ~/.claude, and the macOS
    # Keychain token can't be mounted anyway). Keys for api-mode models come from
    # the fuse .env. Only /cfg (MCP config) is mounted read-only; no host repo.
    args=(-d --name "$NAME" -v "$HERE/mcp.json:/cfg/mcp.json:ro")
    [ -f "$ENV_FILE" ] && args+=(--env-file "$ENV_FILE")
    docker run "${args[@]}" "$IMAGE" >/dev/null
    echo "Sandbox '$NAME' up. CLIs:"
    docker exec "$NAME" bash -lc 'claude --version; codex --version 2>/dev/null; python3 --version'
    [ -f "$ENV_FILE" ] && echo "Passed keys from $ENV_FILE" || echo "No $ENV_FILE — api-mode models need keys."
    # claude/gemini read their env key directly; codex must register the key once
    # (it defaults to ChatGPT OAuth and ignores OPENAI_API_KEY otherwise).
    docker exec "$NAME" bash -lc 'if [ -n "$OPENAI_API_KEY" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 && echo "codex: API key registered"; fi'
    ;;
  login)
    need_docker
    echo "Interactive OAuth inside the sandbox (opens a URL/code to approve on your host browser)."
    echo "→ claude:"; docker exec -it "$NAME" claude /login || true
    echo "→ codex:";  docker exec -it "$NAME" codex login || true
    ;;
  smoke)
    need_docker
    prov="${2:-gemini}"
    RUNID="smoke-$(date +%s)"
    # A SHA-256 of a fixed string: a model can't hash in its head, so a correct
    # digest is proof the agent actually executed a tool (bash/python).
    P='Using a shell tool, compute the SHA-256 hex digest of the exact string fusion-era-2026 (no trailing newline). Output ONLY: FINAL ANSWER: <digest>'
    echo "Reference digest: $(printf '%s' 'fusion-era-2026' | sha256sum 2>/dev/null | cut -d' ' -f1 || printf '%s' 'fusion-era-2026' | shasum -a 256 | cut -d' ' -f1)"
    case "$prov" in
      gemini)
        docker exec "$NAME" bash -lc "export GEMINI_API_KEY=\"\${GEMINI_API_KEY:-\$GOOGLE_API_KEY}\" GEMINI_CLI_TRUST_WORKSPACE=true; mkdir -p /work/$RUNID && cd /work/$RUNID && gemini -m gemini-2.5-pro --yolo -p \"\$1\"" _ "$P"
        ;;
      claude)
        docker exec "$NAME" bash -lc "mkdir -p /work/$RUNID && cd /work/$RUNID && claude -p --model claude-opus-4-8 --permission-mode bypassPermissions --output-format stream-json --verbose \"\$1\"" _ "$P" \
          | jq -rc 'if .type=="assistant" then (.message.content[]? | select(.type=="tool_use") | "TOOL_USE: "+.name) elif .type=="result" then "RESULT: "+(.result//"") else empty end'
        ;;
      codex)
        docker exec "$NAME" bash -lc "mkdir -p /work/$RUNID && cd /work/$RUNID && codex exec --color never -m gpt-5.5 --skip-git-repo-check --sandbox workspace-write \"\$1\"" _ "$P" | tail -3
        ;;
    esac
    echo "--- a correct digest above = the agent executed a tool ---"
    ;;
  exec)
    need_docker; shift
    docker exec -i "$NAME" bash -lc "$*"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "not running"
    ;;
  *)
    echo "usage: sandbox/run.sh {build|up|login|smoke [gemini|claude|codex]|exec <cmd>|down}" >&2
    exit 1
    ;;
esac
