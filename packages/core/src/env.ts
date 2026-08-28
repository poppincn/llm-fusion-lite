/**
 * Minimal .env loader. Loads KEY=VALUE pairs from candidate files into
 * process.env WITHOUT overriding variables already set in the environment
 * (real env always wins). Looked up: $LLM_FUSION_LITE_HOME/.env then ./.env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fusionHome } from "./config.js";
import type { ProviderName } from "./types.js";

const ENV_VAR: Record<ProviderName, string> = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GOOGLE_API_KEY",
    // Default key env for OpenAI-compatible endpoints (override per-model via apiKeyEnv).
    "openai-compatible": "BASETEN_API_KEY"
};

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
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (key) out[key] = val;
    }
    return out;
}

/**
 * Upsert a KEY=value line in ~/.llm-fusion-lite/.env and apply it to process.env
 * immediately (so it takes effect without a restart). Used by the dashboard's
 * provider-key setup. Returns the file path written.
 */
export function writeEnvVar(key: string, value: string): string {
    const dir = fusionHome();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, ".env");
    const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
    let found = false;
    const next = lines.map(line => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        if (t.slice(0, t.indexOf("=")).trim() === key) {
            found = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!found) next.push(`${key}=${value}`);
    writeFileSync(path, next.filter((l, i) => !(l === "" && i === next.length - 1)).join("\n") + "\n", { mode: 0o600 });
    process.env[key] = value;
    return path;
}

/** Set a provider's API key (writes to ~/.llm-fusion-lite/.env + process.env). */
export function setProviderKey(provider: ProviderName, value: string): string {
    return writeEnvVar(ENV_VAR[provider], value);
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
