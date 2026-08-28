/**
 * Custom OpenAI-compatible endpoint tests: auth header construction and
 * per-model key resolution. Pure functions — no network calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { customEndpointHeaders, apiKeyForModel } from "../dist/index.js";

const base = { id: "local-llama", provider: "openai-compatible", model: "llama3.1", label: "Llama (local)" };

test("default auth header is Authorization with Bearer prefix", () => {
    assert.deepEqual(customEndpointHeaders(base, "sk-123"), { Authorization: "Bearer sk-123" });
});

test("custom auth header carries the raw key", () => {
    assert.deepEqual(customEndpointHeaders({ ...base, apiKeyHeader: "api-key" }, "sk-456"), { "api-key": "sk-456" });
});

test("extra headers merge in; auth header wins on collision", () => {
    const h = customEndpointHeaders(
        { ...base, headers: { "X-Title": "app", "api-key": "stale" }, apiKeyHeader: "api-key" },
        "sk-789"
    );
    assert.equal(h["X-Title"], "app");
    assert.equal(h["api-key"], "sk-789");
});

test("apiKeyForModel honors per-model env for openai-compatible", () => {
    delete process.env.BASETEN_API_KEY;
    process.env.MY_LLM_KEY = "k";
    try {
        assert.equal(apiKeyForModel({ ...base, apiKeyEnv: "MY_LLM_KEY" }), "k");
        assert.equal(apiKeyForModel(base), undefined);
    } finally {
        delete process.env.MY_LLM_KEY;
    }
});
