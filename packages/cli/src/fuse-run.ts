#!/usr/bin/env node
/**
 * `fusion-lite-run` bin — thin launcher for the skill orchestrator script.
 * Locates the bundled scripts/fuse-run.sh (works both from the dev workspace
 * and an installed package) and execs it with bash, forwarding all arguments.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
    join(here, "..", "skills", "fuse", "scripts", "fuse-run.sh"), // packaged: <pkg>/dist -> <pkg>/skills
    join(here, "..", "..", "..", "skills", "fuse", "scripts", "fuse-run.sh") // dev: packages/cli/dist -> repo root
];
const script = candidates.find(p => existsSync(p));
if (!script) {
    process.stderr.write("fusion-lite-run: could not locate skills/fuse/scripts/fuse-run.sh\n");
    process.exit(1);
}
const result = spawnSync("bash", [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
