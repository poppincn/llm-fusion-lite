# Publishing `llm-fusion-lite` & wiring it into an agent harness

LLM Fusion Lite ships as a **single bundled, public npm package** exposing the `fusion-lite`,
`fusion-lite-run`, and `fusion-lite-mcp` bins, with the web UI and `/fuse` skill assets included.
A harness **lazily provisions** it (installs on demand, wires the skill) rather than hard-depending on it.

## Build the artifact

```bash
npm run pack:release        # → ./release  (bundled dist + public/ + skills/ + package.json)
(cd release && npm pack --dry-run)   # inspect tarball contents
```

`release/` is git-ignored build output. The bundle inlines all `@llm-fusion-lite/*` workspace code; only the provider SDKs + runtime libs are external deps (declared in `release/package.json`). No native deps (built-in `node:sqlite`). Requires **Node ≥ 22** on the consumer.

## Publish to public npm

```bash
npm login                 # any account you own
npm run pack:release
(cd release && npm publish)   # publishConfig.access=public is already set
```

Bump `version` in the root `package.json` before each publish (the release version is derived from it).
To preview without publishing: `(cd release && npm pack --dry-run)`.

> If the name `llm-fusion-lite` isn't available or you prefer a scope later, change `name` in `scripts/gen-release-pkg.mjs` and rebuild.

## Consume it (harness side)

It's public — **no auth needed to install**:

```bash
npm install -g llm-fusion-lite
# or run without installing:
npx -p llm-fusion-lite fusion-lite doctor
```

### Lazy provisioning recipe

Add a provision step (e.g. `harness provision fusion-lite`, and/or a fallback the first time `/fuse` is used). Idempotent, runs only when the user opts into fusion:

```ts
import { execSync } from "node:child_process";

function hasFusionLite(): boolean {
    try {
        execSync("command -v fusion-lite", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

export function provisionFusionLite(): void {
    if (!hasFusionLite()) {
        execSync("npm install -g llm-fusion-lite", { stdio: "inherit" });
    }
    execSync("fusion-lite setup", { stdio: "inherit" }); // wire /fuse into Claude Code + OpenCode
    execSync("fusion-lite doctor", { stdio: "inherit" }); // surface key/CLI readiness
}
```

Notes:

- **Don't add it to your harness's `dependencies`** — that pulls three provider SDKs into every install. Provision on demand instead (the choice for this project).
- `fusion-lite setup` copies the skill into `~/.claude/{skills,commands}` and `~/.config/opencode/{skill,command}` — the same locations a harness usually already manages, so it composes cleanly. If your harness prefers its own `~/.era/...` + symlink convention, point its skill installer at the package's bundled `skills/` dir instead of calling `fusion-lite setup`.
- The `/fuse` skill is **service-first with CLI fallback**: with provider keys it runs the full engine (and learns); without keys it orchestrates the `claude`/`codex`/`gemini` CLIs a harness usually already has — so fusion works even before any keys are provisioned.
- Your harness can provision provider keys via its existing env/config management, or users can paste them into the served dashboard's **Setup** tab (writes `~/.llm-fusion-lite/.env`). The engine reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`.

## Version & compatibility

- Single package → one version for a harness to pin.
- `engines.node >= 22` is enforced; check the harness Node version before provisioning.
