import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API + OpenAI-compatible routes to the Era Fusion server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
