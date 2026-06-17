// Generates release/package.json by merging runtime deps from the workspace
// packages (excluding internal @era-fusion/* deps, which are bundled in).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(repo, p), "utf8"));

const root = read("package.json");
const pkgs = ["packages/core", "packages/server", "packages/cli"].map((p) =>
  read(join(p, "package.json")),
);

const dependencies = {};
for (const pkg of pkgs) {
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith("@era-fusion/")) continue; // bundled
    dependencies[name] = range;
  }
}

const release = {
  name: "@alexanderollman/llm-fusion",
  version: root.version ?? "0.1.0",
  description:
    "LLM Fusion — multi-model synthesis with adaptive, learned per-subject model strengths. CLI + OpenAI-compatible server + web UI + /fuse skill.",
  type: "module",
  bin: { fuse: "dist/fuse.js", "fuse-run": "dist/fuse-run.js" },
  files: ["dist", "public", "skills", "README.md"],
  engines: { node: ">=22" },
  dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
  // Public package on the npm registry, scoped to the author.
  publishConfig: { access: "public" },
  repository: { type: "git", url: "git+https://github.com/Alexander-Ollman/llm-fusion.git" },
  keywords: ["llm", "fusion", "multi-model", "ensemble", "ai", "anthropic", "openai", "gemini", "claude-code"],
  license: "MIT",
};

writeFileSync(join(repo, "release/package.json"), JSON.stringify(release, null, 2) + "\n");
console.log("wrote release/package.json");
console.log("  deps:", Object.keys(dependencies).join(", "));
