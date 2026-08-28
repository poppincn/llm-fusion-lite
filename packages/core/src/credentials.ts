/**
 * Credential preflight: verify — before ANY model call — that the models a run
 * intends to use actually have usable credentials. Fusion must never dispatch a
 * panelist (or even the cheap adjudicator pre-pass) to a provider that has no
 * API key or an unauthenticated CLI.
 *
 * Two intents, two rules:
 *  - Explicit panel (`panelIds` given) is STRICT: every selected model must be
 *    ready, or the run stops with a clear, per-model remediation message.
 *  - Adaptive selection is best-effort: uncredentialed models are dropped up
 *    front; the run proceeds on the ready subset, and only fails when NONE are
 *    ready.
 *
 * Subscription (CLI) providers are auth-probed here (see cliAuthProbe) so a
 * present-but-unauthenticated CLI (e.g. `gemini` exiting 41 mid-run) is caught
 * at preflight and reported, not discovered halfway through a panel.
 */
import type { FusionConfig } from "./config.js";
import { authModeFor, getModel } from "./config.js";
import { cliAvailable, cliAuthProbe } from "./providers/cli.js";
import type { ModelSpec, ProviderAuthMode, ProviderName } from "./types.js";

interface ProviderMeta {
    /** API-key env var (default for the provider). */
    env: string;
    /** Subscription CLI binary, when the provider has one. */
    cli?: string;
    /** npm package that installs the CLI. */
    pkg?: string;
    /** How to log the CLI in. */
    login?: string;
}

const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
    "anthropic": { env: "ANTHROPIC_API_KEY", cli: "claude", pkg: "@anthropic-ai/claude-code", login: "claude /login" },
    "openai": { env: "OPENAI_API_KEY", cli: "codex", pkg: "@openai/codex", login: "codex login" },
    "google": { env: "GOOGLE_API_KEY", cli: "gemini", pkg: "@google/gemini-cli", login: "run `gemini` and sign in" },
    "openai-compatible": { env: "BASETEN_API_KEY" }
};

/** The API-key env var a model reads (per-model override wins). */
function apiEnvFor(spec: ModelSpec): string {
    if (spec.apiKeyEnv) return spec.apiKeyEnv;
    return PROVIDER_META[spec.provider].env;
}

/** True if the model's API key is present in the environment. */
function apiKeyPresent(spec: ModelSpec): boolean {
    if (process.env[apiEnvFor(spec)]) return true;
    // Google accepts either GOOGLE_API_KEY or GEMINI_API_KEY.
    if (spec.provider === "google" && !spec.apiKeyEnv && process.env.GEMINI_API_KEY) return true;
    return false;
}

/**
 * True if a model has usable credentials for its adapter's auth mode — a key
 * in the environment (per-model env honored) or a subscription CLI on PATH.
 */
export function modelCredentialReady(spec: ModelSpec): boolean {
    const mode = authModeFor(spec.provider);
    if (mode === "subscription") return cliAvailable(spec.provider);
    return apiKeyPresent(spec);
}

export interface CredentialStatus {
    modelId: string;
    provider: ProviderName | "unknown";
    mode: ProviderAuthMode;
    ready: boolean;
    /** Remediation when not ready, or an advisory note when ready (e.g. inconclusive probe). */
    reason?: string;
}

export interface PreflightResult {
    /** Whether the run may proceed. */
    ok: boolean;
    /** Explicit panel (strict: all must be ready) vs adaptive (best-effort: ≥1 ready). */
    strict: boolean;
    /** Model ids that have usable credentials, in the order intended. */
    ready: CredentialStatus[];
    /** Model ids that lack usable credentials, with per-model remediation. */
    missing: CredentialStatus[];
}

/** Verify credentials for one model id (auth-probing subscription CLIs). */
async function checkModel(config: FusionConfig, id: string, signal?: AbortSignal): Promise<CredentialStatus> {
    const spec = getModel(config, id);
    if (!spec) {
        return {
            modelId: id,
            provider: "unknown",
            mode: "api",
            ready: false,
            reason: `unknown model id "${id}" — not in the registry`
        };
    }
    const mode = authModeFor(spec.provider, config);
    const meta = PROVIDER_META[spec.provider];

    if (mode === "subscription") {
        if (!cliAvailable(spec.provider)) {
            const pkg = meta.pkg ? ` — install with \`npm i -g ${meta.pkg}\`` : "";
            return {
                modelId: id,
                provider: spec.provider,
                mode,
                ready: false,
                reason: `${meta.cli ?? "CLI"} not on PATH${pkg}`
            };
        }
        const probe = await cliAuthProbe(spec.provider, spec.model, signal);
        if (probe.authenticated) {
            return { modelId: id, provider: spec.provider, mode, ready: true, reason: probe.reason };
        }
        const login = meta.login ? ` — ${meta.login}` : "";
        return {
            modelId: id,
            provider: spec.provider,
            mode,
            ready: false,
            reason: `${probe.reason ?? "unauthenticated"}${login}`
        };
    }

    // API-key mode.
    if (apiKeyPresent(spec)) {
        return { modelId: id, provider: spec.provider, mode, ready: true };
    }
    const env = apiEnvFor(spec);
    return {
        modelId: id,
        provider: spec.provider,
        mode,
        ready: false,
        reason: `no ${env} — export ${env}=… or run \`fuse setup\``
    };
}

/**
 * Run the credential preflight. Pass `panelIds` for an explicit (strict) panel;
 * omit it to check the adaptive auto-panel. Never throws — returns the verdict.
 */
export async function preflightCredentials(
    config: FusionConfig,
    panelIds?: string[],
    signal?: AbortSignal
): Promise<PreflightResult> {
    const strict = !!(panelIds && panelIds.length);
    const targetIds =
        strict ?
            panelIds!
        :   config.autoPanel.filter(id => {
                const s = getModel(config, id);
                return s && !s.excludeFromAuto;
            });

    const ready: CredentialStatus[] = [];
    const missing: CredentialStatus[] = [];
    for (const id of targetIds) {
        const status = await checkModel(config, id, signal);
        (status.ready ? ready : missing).push(status);
    }

    const ok = strict ? missing.length === 0 && ready.length > 0 : ready.length > 0;
    return { ok, strict, ready, missing };
}

/** Format missing-credential rows into an actionable, multi-line message. */
export function formatMissingCredentials(missing: CredentialStatus[]): string {
    return missing.map(s => `  • ${s.modelId} (${s.provider}/${s.mode}): ${s.reason ?? "not configured"}`).join("\n");
}
