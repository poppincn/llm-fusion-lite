/**
 * Provider-instance materialization tests. Pure functions — no disk/network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeConfig, defaultProvidersFor } from "../dist/index.js";

const baseConfig = {
    models: [
        { id: "m1", provider: "anthropic", model: "claude-x", label: "Claude X" },
        {
            id: "m2",
            provider: "openai-compatible",
            model: "llama",
            label: "Llama",
            baseURL: "http://old/v1",
            apiKeyEnv: "OLD_KEY"
        }
    ],
    autoPanel: ["m1", "m2"],
    defaultJudge: "m1",
    classifierModel: "m1",
    panelSize: 2,
    webSearch: false,
    explorationRate: 0.1,
    categories: ["other"]
};

test("legacy synthesis: defaults fill in and models attach to default instances", () => {
    const cfg = materializeConfig({ ...baseConfig, providers: defaultProvidersFor(baseConfig) });
    assert.equal(cfg.providers.length, 4);
    assert.equal(cfg.models[0].providerId, "anthropic");
    assert.equal(cfg.models[1].providerId, "custom");
});

test("explicit empty providers array is preserved (deletion regression)", () => {
    const cfg = materializeConfig({ ...baseConfig, providers: [] });
    assert.equal(cfg.providers.length, 0);
    // Models survive without an instance; their adapter still drives dispatch.
    assert.equal(cfg.models[0].provider, "anthropic");
});

test("legacy custom model config migrates onto the default custom provider", () => {
    const cfg = materializeConfig({ ...baseConfig, providers: defaultProvidersFor(baseConfig) });
    const custom = cfg.providers.find(p => p.adapter === "openai-compatible");
    assert.equal(custom.baseURL, "http://old/v1");
    assert.equal(custom.apiKeyEnv, "OLD_KEY");
});

test("defaultProvidersFor inherits legacy custom model config", () => {
    const providers = defaultProvidersFor(baseConfig);
    const custom = providers.find(p => p.adapter === "openai-compatible");
    assert.equal(custom.baseURL, "http://old/v1");
    assert.equal(custom.apiKeyEnv, "OLD_KEY");
});

test("provider instance fields merge onto attached models", () => {
    const cfg = materializeConfig({
        ...baseConfig,
        providers: [
            { id: "openai-pro", name: "OpenAI Pro", adapter: "openai", apiKeyEnv: "OPENAI_PRO_KEY" },
            {
                id: "ollama",
                name: "Ollama",
                adapter: "openai-compatible",
                baseURL: "http://localhost:11434/v1",
                apiKeyEnv: "OLLAMA_KEY"
            }
        ],
        models: [
            { id: "m1", provider: "anthropic", model: "claude-x", label: "Claude X" },
            { id: "m3", provider: "openai", providerId: "openai-pro", model: "gpt-x", label: "GPT X" },
            { id: "m4", provider: "openai-compatible", providerId: "ollama", model: "llama3.1", label: "Llama Local" }
        ]
    });
    const m3 = cfg.models.find(m => m.id === "m3");
    const m4 = cfg.models.find(m => m.id === "m4");
    assert.equal(m3.apiKeyEnv, "OPENAI_PRO_KEY");
    assert.equal(m4.baseURL, "http://localhost:11434/v1");
    assert.equal(m4.apiKeyEnv, "OLLAMA_KEY");
    assert.equal(m4.provider, "openai-compatible");
});

test("model-level fields act as fallback when the provider lacks them", () => {
    const cfg = materializeConfig({
        ...baseConfig,
        providers: [{ id: "ollama", name: "Ollama", adapter: "openai-compatible" }],
        models: [
            {
                id: "m1",
                provider: "openai-compatible",
                providerId: "ollama",
                model: "x",
                label: "X",
                baseURL: "http://fb/v1"
            }
        ]
    });
    assert.equal(cfg.models[0].baseURL, "http://fb/v1");
});
