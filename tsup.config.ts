import { defineConfig } from "tsup";

/**
 * Bundles the CLI + fuse-run launcher into a single publishable artifact.
 * Our own workspace code (@llm-fusion-lite/*) is inlined; third-party SDKs and
 * runtime libs stay external and are declared as deps of the release package.
 */
export default defineConfig({
    entry: {
        "fusion-lite": "packages/cli/src/index.ts",
        "fusion-lite-run": "packages/cli/src/fuse-run.ts",
        "fusion-lite-mcp": "packages/cli/src/mcp.ts"
    },
    outDir: "release/dist",
    format: ["esm"],
    platform: "node",
    target: "node22",
    bundle: true,
    splitting: false,
    clean: true,
    noExternal: [/^@llm-fusion-lite\//],
    external: [
        "@anthropic-ai/sdk",
        "@google/genai",
        "openai",
        "hono",
        "@hono/node-server",
        "commander",
        "chalk",
        "@clack/prompts",
        "@modelcontextprotocol/sdk",
        "zod",
        // newer Node builtin not in esbuild's known list — keep the node: prefix
        "node:sqlite"
    ]
    // No banner: the entry files already start with a hashbang, which esbuild
    // preserves and hoists to line 1. Adding a banner would duplicate it.
});
