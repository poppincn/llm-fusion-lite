/** Era Fusion core — public API. */
export * from "./types.js";
export {
  loadConfig,
  saveConfig,
  getModel,
  apiKeyFor,
  authModeFor,
  setProviderAuthMode,
  resolveTechniques,
  TECHNIQUES_OFF,
  TECHNIQUES_DEEP,
  fusionHome,
  configPath,
  dbPath,
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
  DEFAULT_CATEGORIES,
} from "./config.js";
export type { FusionConfig } from "./config.js";
export { fuse, availableAutoPanel } from "./fusion.js";
export type { FuseDeps } from "./fusion.js";
export { preflightCredentials, formatMissingCredentials } from "./credentials.js";
export type { CredentialStatus, PreflightResult } from "./credentials.js";
export { cliAvailable, cliAuthProbe, cliLoginStatus, classifyCliError, resetAuthProbeCache } from "./providers/cli.js";
export type { CliAuthResult } from "./providers/cli.js";
export { FusionStore } from "./store.js";
export type {
  ModelStrength,
  PanelPick,
  ProviderUsage,
  ModelUsage,
  UsageTotals,
  UsageReport,
} from "./store.js";
export { loadEnv, writeEnvVar, setProviderKey } from "./env.js";
export { classifyPrompt } from "./classify.js";
export { adjudicate } from "./adjudicate.js";
export type { Adjudication } from "./adjudicate.js";
export { resolveJudge, runJudgeAnalysis, runJudgeSynthesis } from "./judge.js";
export {
  getProvider,
  configuredProviders,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
} from "./providers/index.js";
