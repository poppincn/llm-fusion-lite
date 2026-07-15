/**
 * Credential-preflight, empty-prompt-guard, and CLI-error-classifier tests.
 * Runs against the compiled dist (node --test), so `npm run build:core` first.
 * These exercise API-key models only (no subscription CLIs) so nothing spawns a
 * subprocess or makes a network call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preflightCredentials,
  formatMissingCredentials,
  classifyCliError,
  fuse,
  DEFAULT_CONFIG,
} from "../dist/index.js";

const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "BASETEN_API_KEY",
];
function clearKeys() {
  for (const k of KEY_VARS) delete process.env[k];
}

test("empty prompt is rejected before any model call", async () => {
  await assert.rejects(
    () => fuse({ prompt: "   \n\t " }, { config: DEFAULT_CONFIG }),
    /Empty prompt/,
  );
});

test("preflight (adaptive): no credentials → not ok, nothing ready", async () => {
  clearKeys();
  const r = await preflightCredentials(DEFAULT_CONFIG);
  assert.equal(r.ok, false);
  assert.equal(r.strict, false);
  assert.equal(r.ready.length, 0);
  assert.ok(r.missing.length >= 1);
  // remediation text is actionable
  assert.match(formatMissingCredentials(r.missing), /export .*_API_KEY/);
});

test("preflight (adaptive): one API key present → ready subset, others missing", async () => {
  clearKeys();
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  try {
    const r = await preflightCredentials(DEFAULT_CONFIG);
    assert.equal(r.ok, true); // adaptive passes on ≥1 ready
    assert.ok(r.ready.some((s) => s.provider === "anthropic"));
    assert.ok(r.missing.some((s) => s.provider === "openai" || s.provider === "google"));
  } finally {
    clearKeys();
  }
});

test("preflight (strict): explicit panel with an uncredentialed model → not ok", async () => {
  clearKeys();
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  try {
    const r = await preflightCredentials(DEFAULT_CONFIG, ["claude-opus-4-8", "gpt-5.5"]);
    assert.equal(r.strict, true);
    assert.equal(r.ok, false); // gpt-5.5 lacks OPENAI_API_KEY
    assert.ok(r.ready.some((s) => s.modelId === "claude-opus-4-8"));
    assert.ok(r.missing.some((s) => s.modelId === "gpt-5.5"));
  } finally {
    clearKeys();
  }
});

test("preflight (strict): all selected models credentialed → ok", async () => {
  clearKeys();
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  try {
    const r = await preflightCredentials(DEFAULT_CONFIG, ["claude-opus-4-8", "claude-sonnet-4-6"]);
    assert.equal(r.ok, true);
    assert.equal(r.missing.length, 0);
  } finally {
    clearKeys();
  }
});

test("preflight: unknown model id is reported as missing", async () => {
  clearKeys();
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  try {
    const r = await preflightCredentials(DEFAULT_CONFIG, ["no-such-model"]);
    assert.equal(r.ok, false);
    assert.ok(r.missing.some((s) => s.modelId === "no-such-model" && /unknown model/i.test(s.reason)));
  } finally {
    clearKeys();
  }
});

test("classifyCliError: exit 41 and auth phrases → auth", () => {
  assert.equal(classifyCliError(41, "gemini: no output"), "auth");
  assert.equal(classifyCliError(1, "Error: not authenticated"), "auth");
  assert.equal(classifyCliError(1, "Please sign in to continue"), "auth");
  assert.equal(classifyCliError(1, "authentication required"), "auth");
});

test("classifyCliError: non-auth failures classified accordingly", () => {
  assert.equal(classifyCliError(124, "the command timed out"), "timeout");
  assert.equal(classifyCliError(127, "spawn gemini ENOENT"), "unavailable");
  assert.equal(classifyCliError(1, "internal model error 500"), "other");
});
