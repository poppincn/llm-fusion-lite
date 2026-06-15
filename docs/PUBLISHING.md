# Publishing `@era-laboratories/llm-fusion` & wiring it into era-code

LLM Fusion ships as a **single bundled npm package** exposing the `fuse` and `fuse-run` bins, with the web UI and `/fuse` skill assets included. era-code **lazily provisions** it (installs on demand, wires the skill) rather than hard-depending on it.

## Build the artifact

```bash
npm run pack:release        # → ./release  (bundled dist + public/ + skills/ + package.json)
(cd release && npm pack --dry-run)   # inspect tarball contents
```

`release/` is git-ignored build output. The bundle inlines all `@era-fusion/*` workspace code; only the provider SDKs + runtime libs are external deps (declared in `release/package.json`). No native deps (uses built-in `node:sqlite`). Requires **Node ≥ 22** on the consumer.

## Publish to GitHub Packages (private)

> ⚠️ **Scope must match the owner.** GitHub Packages requires the npm scope to equal the owning GitHub org/user. The package is scoped `@era-laboratories`, so the repo must live under a GitHub org named **`era-laboratories`**. The repo is currently `Alexander-Ollman/llm-fusion`. Before publishing, either:
> 1. **Transfer the repo to an `era-laboratories` org** (recommended — matches the scope and era-code's `@era-laboratories/era-code`), then update `repository.url` in `scripts/gen-release-pkg.mjs`; or
> 2. Re-scope to the current owner: change the name to `@alexander-ollman/llm-fusion` in `scripts/gen-release-pkg.mjs`; or
> 3. Use a different private registry (Verdaccio, Artifactory, npm private) — set `publishConfig.registry` accordingly. Then the scope/owner rule above doesn't apply.

Auth (publisher) — PAT with `write:packages`:

```bash
# ~/.npmrc
@era-laboratories:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Publish:

```bash
npm run pack:release
(cd release && npm publish)
```

Bump `version` in the root `package.json` before each publish (the release version is derived from it).

## Consume it (era-code side)

Consumers need a read-scoped `.npmrc` (PAT with `read:packages`):

```bash
@era-laboratories:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

### Lazy provisioning recipe for era-code

Add a provision step (a new command/configurator, e.g. `era-code provision fusion`, and/or a fallback when `/fuse` is first used). It should be idempotent and only run when the user opts into fusion:

```ts
import { execSync } from "node:child_process";

function hasFuse(): boolean {
  try { execSync("command -v fuse", { stdio: "ignore" }); return true; }
  catch { return false; }
}

export function provisionFusion(): void {
  if (!hasFuse()) {
    // Install the bundled package globally (or into era-code's managed prefix).
    execSync("npm install -g @era-laboratories/llm-fusion", { stdio: "inherit" });
  }
  // Wire the /fuse skill + command into the active harnesses (Claude Code / OpenCode).
  execSync("fuse setup", { stdio: "inherit" });
  // Surface readiness (provider keys / CLIs) to the user.
  execSync("fuse doctor", { stdio: "inherit" });
}
```

Notes:
- **Don't add it to era-code's `dependencies`** — that would pull three provider SDKs into every era-code install. Provision on demand instead (the choice made for this project).
- `fuse setup` copies the skill into `~/.claude/{skills,commands}` and `~/.config/opencode/{skill,command}` — the same locations era-code already manages, so it composes cleanly. If era-code prefers its own `~/.era/...` + symlink convention, point its skill installer at the package's bundled `skills/` dir instead of calling `fuse setup`.
- The `/fuse` skill is **service-first with CLI fallback**: with provider keys it runs the full engine (and learns); without keys it orchestrates the `claude`/`codex`/`gemini` CLIs an era-code harness usually already has. So fusion works for era-code users even before any keys are provisioned.
- era-code can provision provider keys via its existing env/config management; the engine reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` (or a `~/.era-fusion/.env`).

## Version & compatibility
- Single package → one version for era-code to pin.
- `engines.node >= 22` is enforced; era-code should check the harness Node version before provisioning.
