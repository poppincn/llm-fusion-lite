import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "llm-fusion-lite-gateway-"));
process.env.LLM_FUSION_LITE_HOME = home;

let app;
let webApp;

before(async () => {
    const { createApp } = await import("../dist/app.js");
    app = createApp({ store: {} });
    webApp = createApp({ store: {}, publicDir: resolve("packages/web/dist") });
});

after(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.LLM_FUSION_LITE_HOME;
});

test("gateway is open by default and advertises the inferred base URL", async () => {
    const config = await app.request("http://localhost:8787/api/config");
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.deepEqual(body.gateway, {
        baseURL: "http://localhost:8787/v1",
        baseURLAuto: true,
        model: "fusion",
        apiKeySet: false
    });

    const models = await app.request("http://localhost:8787/v1/models");
    assert.equal(models.status, 200);
});

test("gateway settings hot-update model, public URL, and optional API key", async () => {
    const update = await app.request("http://localhost:8787/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            gateway: { baseURL: "https://fusion.example.com/v1/", model: "fusion-team", apiKey: "secret-1234" }
        })
    });
    assert.equal(update.status, 200);
    const updated = await update.json();
    assert.deepEqual(updated.config.gateway, {
        baseURL: "https://fusion.example.com/v1",
        baseURLAuto: false,
        model: "fusion-team",
        apiKeySet: true,
        apiKeyHint: "••••1234"
    });
    assert.equal(JSON.stringify(updated).includes("secret-1234"), false);

    const persisted = readFileSync(join(home, "config.json"), "utf8");
    assert.equal(persisted.includes("secret-1234"), false);
    assert.match(persisted, /"apiKeyHash": "sha256:/);

    const missing = await app.request("http://localhost:8787/v1/models");
    assert.equal(missing.status, 401);

    const preflight = await app.request("http://localhost:8787/v1/models", {
        method: "OPTIONS",
        headers: {
            "Origin": "https://agent.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization"
        }
    });
    assert.ok(preflight.status >= 200 && preflight.status < 300);

    const wrong = await app.request("http://localhost:8787/v1/models", { headers: { Authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);

    const authorized = await app.request("http://localhost:8787/v1/models", {
        headers: { Authorization: "Bearer secret-1234" }
    });
    assert.equal(authorized.status, 200);
    const models = await authorized.json();
    assert.equal(models.data[0].id, "fusion-team");
});

test("empty API key disables authentication without restarting", async () => {
    const update = await app.request("http://localhost:8787/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway: { apiKey: "" } })
    });
    assert.equal(update.status, 200);

    const models = await app.request("http://localhost:8787/v1/models");
    assert.equal(models.status, 200);
});

test("chat completions reject unknown public model names before fusion", async () => {
    const response = await app.request("http://localhost:8787/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "unknown", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "model_not_found");
});

test("each dashboard page has a directly refreshable HTML entry", async () => {
    const pages = [
        ["/", "<title>LLM Fusion Lite</title>"],
        ["/strengths/", "<title>Strengths · LLM Fusion Lite</title>"],
        ["/usage/", "<title>Usage · LLM Fusion Lite</title>"],
        ["/connect/", "<title>Connect · LLM Fusion Lite</title>"],
        ["/setup/", "<title>Setup · LLM Fusion Lite</title>"]
    ];
    for (const [path, title] of pages) {
        const response = await webApp.request(`http://localhost:8787${path}`);
        assert.equal(response.status, 200, path);
        assert.ok((await response.text()).includes(title), path);
    }
});

test("provider keys get an internal env name that is not exposed to the browser", async () => {
    const current = await (await app.request("http://localhost:8787/api/config")).json();
    const providers = [...current.providers, { id: "team-openai", name: "Team OpenAI", adapter: "openai" }];
    const saved = await app.request("http://localhost:8787/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers })
    });
    assert.equal(saved.status, 200);

    const keyResult = await app.request("http://localhost:8787/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "team-openai", key: "team-secret" })
    });
    assert.equal(keyResult.status, 200);
    const response = await keyResult.json();
    const provider = response.config.providers.find(item => item.id === "team-openai");
    assert.equal(provider.keySet, true);
    assert.equal("apiKeyEnv" in provider, false);
    assert.equal(process.env.LLM_FUSION_LITE_PROVIDER_TEAM_OPENAI_API_KEY, "team-secret");
});
