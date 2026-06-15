/**
 * Minimal .env loader. Loads KEY=VALUE pairs from candidate files into
 * process.env WITHOUT overriding variables already set in the environment
 * (real env always wins). Looked up: $ERA_FUSION_HOME/.env then ./.env.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fusionHome } from "./config.js";

let loaded = false;

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** Load .env files into process.env once. Existing env vars are never overwritten. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const candidates = [join(fusionHome(), ".env"), join(process.cwd(), ".env")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const vars = parseEnv(readFileSync(path, "utf8"));
      for (const [k, v] of Object.entries(vars)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      // ignore unreadable .env
    }
  }
}
