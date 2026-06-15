# Publishing `@alexander-ollman/llm-fusion` & wiring it into era-code

LLM Fusion ships as a **single bundled, public npm package** exposing the `fuse` and `fuse-run` bins, with the web UI and `/fuse` skill assets included. era-code **lazily provisions** it (installs on demand, wires the skill) rather than hard-depending on it.

## Build the artifact

```bash
npm run pack:release        # → ./release  (bundled dist + public/ + skills/ + package.json)
(cd release && npm pack --dry-run)   # inspect tarball contents
```

`release/` is git-ignored build output. The bundle inlines all `@era-fusion/*` workspace code; only the provider SDKs + runtime libs are external deps (declared in `release/package.json`). No native deps (built-in `node:sqlite`). Requires **Node ≥ 22** on the consumer.

## Publish to public npm

The package is scoped `@alexander-ollman` and published publicly to the default npm registry. The scope must be an npm username or org you own — log in as / be a member of **`alexander-ollman`**.

```bash
npm login                 # as the alexander-ollman account (or an org member)
npm run pack:release
(cd release && npm publish)   # publishConfig.access=public is already set
```

Bump `version` in the root `package.json` before each publish (the release version is derived from it). To preview without publishing: `(cd release && npm pack --dry-run)`.

> If the name `@alexander-ollman/llm-fusion` isn't available or you prefer an org later, change `name` in `scripts/gen-release-pkg.mjs` and rebuild.

## Consume it (era-code side)

It's public — **no auth needed to install**:

```bash
npm install -g @alexander-ollman/llm-fusion
# or run without installing:
npx @alexander-ollman/llm-fusion doctor
```

### Lazy provisioning recipe for era-code

Add a provision step (e.g. `era-code provision fusion`, and/or a fallback the first time `/fuse` is used). Idempotent, runs only when the user opts into fusion:

```ts
import { execSync } from "node:child_process";

function hasFuse(): boolean {
  try { execSync("command -v fuse", { stdio: "ignore" }); return true; }
  catch { return false; }
}

export function provisionFusion(): void {
  if (!hasFuse()) {
    execSync("npm install -g @alexander-ollman/llm-fusion", { stdio: "inherit" });
  }
  execSync("fuse setup", { stdio: "inherit" });   // wire /fuse into Claude Code + OpenCode
  execSync("fuse doctor", { stdio: "inherit" });  // surface key/CLI readiness
}
```

Notes:
- **Don't add it to era-code's `dependencies`** — that pulls three provider SDKs into every era-code install. Provision on demand instead (the choice for this project).
- `fuse setup` copies the skill into `~/.claude/{skills,commands}` and `~/.config/opencode/{skill,command}` — the same locations era-code already manages, so it composes cleanly. If era-code prefers its own `~/.era/...` + symlink convention, point its skill installer at the package's bundled `skills/` dir instead of calling `fuse setup`.
- The `/fuse` skill is **service-first with CLI fallback**: with provider keys it runs the full engine (and learns); without keys it orchestrates the `claude`/`codex`/`gemini` CLIs an era-code harness usually already has — so fusion works even before any keys are provisioned.
- era-code can provision provider keys via its existing env/config management, or users can paste them into the served dashboard's **Setup** tab (writes `~/.era-fusion/.env`). The engine reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`.

## Version & compatibility
- Single package → one version for era-code to pin.
- `engines.node >= 22` is enforced; era-code should check the harness Node version before provisioning.
