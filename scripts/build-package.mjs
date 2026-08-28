import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const release = join(repo, "release");
const npmCli = process.env.npm_execpath;

function runNode(args) {
    const result = spawnSync(process.execPath, args, { cwd: repo, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNpm(args) {
    if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through `npm run pack:release`");
    runNode([npmCli, ...args]);
}

console.log("==> Building workspace…");
runNpm(["run", "build"]);

console.log("==> Bundling CLI (tsup)…");
runNpm(["exec", "--", "tsup"]);

console.log("==> Assembling release/ assets…");
rmSync(join(release, "public"), { recursive: true, force: true });
rmSync(join(release, "skills"), { recursive: true, force: true });
mkdirSync(join(release, "public"), { recursive: true });
mkdirSync(join(release, "skills"), { recursive: true });
cpSync(join(repo, "packages", "web", "dist"), join(release, "public"), { recursive: true });
cpSync(join(repo, "skills"), join(release, "skills"), { recursive: true });
cpSync(join(repo, "README.md"), join(release, "README.md"));
cpSync(join(repo, "README.zh-CN.md"), join(release, "README.zh-CN.md"));
const skillRunner = join(release, "skills", "fuse", "scripts", "fuse-run.sh");
if (existsSync(skillRunner) && process.platform !== "win32") chmodSync(skillRunner, 0o755);

console.log("==> Generating release/package.json…");
runNode(["scripts/gen-release-pkg.mjs"]);

console.log("\n==> Done. Publishable package in ./release");
console.log("    Preview:  cd release && npm pack --dry-run");
console.log("    Publish:  cd release && npm publish");
