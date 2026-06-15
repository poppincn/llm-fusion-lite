#!/usr/bin/env bash
# Era Fusion setup: install deps, build, put `fuse`/`fuse-run` on PATH, and
# install the /fuse skill into Claude Code and OpenCode. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ERA_FUSION_BIN:-$HOME/.local/bin}"
cd "$REPO"

echo "==> Era Fusion setup ($REPO)"

# 1. Dependencies + build
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies…"
  npm install
fi
echo "==> Building workspace…"
npm run build

# 2. Bundle the built web UI into the server for production serving
mkdir -p packages/server/public
cp -R packages/web/dist/* packages/server/public/ 2>/dev/null || true

# 3. Launchers on PATH
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/fuse" <<EOF
#!/usr/bin/env bash
exec node "$REPO/packages/cli/dist/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/fuse"

cat > "$BIN_DIR/fuse-run" <<EOF
#!/usr/bin/env bash
exec bash "$REPO/skills/fuse/scripts/fuse-run.sh" "\$@"
EOF
chmod +x "$BIN_DIR/fuse-run"
chmod +x "$REPO/skills/fuse/scripts/fuse-run.sh"
echo "==> Installed launchers to $BIN_DIR (fuse, fuse-run)"

# 4. Install the /fuse skill into harnesses
install_skill() {
  local skills_dir="$1" commands_dir="$2" label="$3"
  [ -z "$skills_dir" ] && return 0
  mkdir -p "$skills_dir/fuse/scripts" "$commands_dir"
  cp "$REPO/skills/fuse/SKILL.md" "$skills_dir/fuse/SKILL.md"
  cp "$REPO/skills/fuse/scripts/fuse-run.sh" "$skills_dir/fuse/scripts/fuse-run.sh"
  chmod +x "$skills_dir/fuse/scripts/fuse-run.sh"
  cp "$REPO/skills/commands/fuse.md" "$commands_dir/fuse.md"
  echo "==> Installed /fuse skill for $label"
}

# Claude Code
install_skill "$HOME/.claude/skills" "$HOME/.claude/commands" "Claude Code"
# OpenCode (uses singular skill/ and command/ dirs)
OPENCODE_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
install_skill "$OPENCODE_BASE/skill" "$OPENCODE_BASE/command" "OpenCode"

# 5. PATH hint + doctor
echo
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "!!  $BIN_DIR is not on your PATH. Add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
echo "==> Done. Running doctor…"
echo
node "$REPO/packages/cli/dist/index.js" doctor || true

echo
echo "Next:"
echo "  • Set provider keys: export ANTHROPIC_API_KEY=…  (optionally OPENAI_API_KEY, GOOGLE_API_KEY)"
echo "  • CLI:    fuse \"your question\""
echo "  • Server+UI: fuse serve   →  http://localhost:8787"
echo "  • Agent:  /fuse <request>   (Claude Code / OpenCode)"
