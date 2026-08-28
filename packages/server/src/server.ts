import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@llm-fusion-lite/core";
import { createApp } from "./app.js";

export interface StartOptions {
    port?: number;
    /** Override the built web UI directory. Defaults to bundled ./public. */
    publicDir?: string;
}

/** Locate a built web UI: explicit override, bundled public, or workspace build. */
function resolvePublicDir(override?: string): string | undefined {
    if (override && existsSync(override)) return resolve(override);
    const here = dirname(fileURLToPath(import.meta.url)); // .../packages/server/dist
    const candidates = [
        join(here, "..", "public"), // packages/server/public (bundled)
        join(here, "..", "..", "web", "dist") // packages/web/dist (dev/workspace)
    ];
    return candidates.find(p => existsSync(join(p, "index.html")));
}

export function startServer(options: StartOptions = {}): { port: number } {
    loadEnv();
    const port = options.port ?? Number(process.env.LLM_FUSION_LITE_PORT ?? 8787);
    const publicDir = resolvePublicDir(options.publicDir);
    const app = createApp({ publicDir });
    serve({ fetch: app.fetch, port });
    return { port };
}
