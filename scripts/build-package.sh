#!/usr/bin/env bash
# Build the single publishable @era-laboratories/llm-fusion artifact into ./release
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "==> Building workspace…"
npm run build

echo "==> Bundling CLI (tsup)…"
npx tsup

echo "==> Assembling release/ assets…"
rm -rf release/public release/skills
mkdir -p release/public release/skills
cp -R packages/web/dist/* release/public/
cp -R skills/* release/skills/
cp README.md release/README.md 2>/dev/null || true
cp README.zh-CN.md release/README.zh-CN.md 2>/dev/null || true
chmod +x release/skills/fuse/scripts/fuse-run.sh

echo "==> Generating release/package.json…"
node scripts/gen-release-pkg.mjs

echo
echo "==> Done. Publishable package in ./release"
echo "    Preview:  (cd release && npm pack --dry-run)"
echo "    Publish:  (cd release && npm publish)   # needs GitHub Packages auth (see docs/PUBLISHING.md)"
