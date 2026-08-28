import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Dev server proxies API + OpenAI-compatible routes to the LLM Fusion Lite server.
export default defineConfig({
    plugins: [react()],
    server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/v1": "http://localhost:8787" } },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                chat: resolve(root, "index.html"),
                strengths: resolve(root, "strengths/index.html"),
                usage: resolve(root, "usage/index.html"),
                connect: resolve(root, "connect/index.html"),
                setup: resolve(root, "setup/index.html")
            }
        }
    }
});
