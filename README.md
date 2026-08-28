<div align="center">

# LLM Fusion Lite

**Run several LLMs in parallel, synthesize one answer, and expose the result as one OpenAI-compatible model.**

[简体中文](README.zh-CN.md) · [License](LICENSE) · [Agentic mode](docs/AGENTIC_FUSION.md) · [MCP](docs/MCP.md)

</div>

> LLM Fusion Lite is a lightweight fork of [llm-fusion](https://github.com/Alexander-Ollman/llm-fusion) ("Era Fusion", © Alexander Ollman, MIT). It keeps the parallel panel, two-phase judge, learned per-subject strengths, CLI, web UI, MCP server, and `/fuse` skill.

## What you get

- **One fused model for your Agent** — OpenAI-compatible `POST /v1/chat/completions`.
- **Flexible providers** — Anthropic, OpenAI, Google, or any Chat Completions-compatible service such as Volcengine Ark, OpenRouter, Ollama, vLLM, DeepSeek, or Qwen.
- **Web configuration** — providers, models, judge, panel size, gateway model name, public Base URL, and optional gateway API key.
- **Hot updates** — gateway Base URL, model name, and API key apply to new requests immediately.
- **Stable pages** — `/`, `/strengths/`, `/usage/`, `/connect/`, and `/setup/` can be refreshed or linked directly.
- **Adaptive learning** — model contribution and feedback gradually influence future panel selection.

## Status

The `llm-fusion-lite` npm package is **not published yet**. Install from source using the steps below. The repository requires **Node.js 22 or newer**; Node.js 24+ is recommended.

## End-to-end quick start

### 1. Clone and build

```bash
git clone https://github.com/jamcaaxian/llm-fusion.git
cd llm-fusion
npm install
npm run build
```

Optional on macOS/Linux: install the local launchers and `/fuse` skill.

```bash
./scripts/install.sh
```

On Windows, or without installing launchers, use `npm run fusion-lite --` before CLI arguments:

```powershell
npm run fusion-lite -- doctor
```

### 2. Start the web UI

```bash
npm run start --workspace=@llm-fusion-lite/server
```

Open:

- Setup: <http://localhost:8787/setup/>
- Connect your Agent: <http://localhost:8787/connect/>
- Chat: <http://localhost:8787/>

To use another port:

```powershell
$env:LLM_FUSION_LITE_PORT = "9000"
npm run start --workspace=@llm-fusion-lite/server
```

```bash
LLM_FUSION_LITE_PORT=9000 npm run start --workspace=@llm-fusion-lite/server
```

### 3. Add a provider

Open **Setup → Providers → Add Provider**.

#### Official provider

Choose Anthropic, OpenAI, or Google, then enter:

1. **Name** — any label, such as `OpenAI Production`.
2. **id** — a stable internal slug, such as `openai-prod`.
3. **Adapter** — the official provider.
4. **Key** — optional when editing; blank keeps the current key.

#### Custom OpenAI-compatible provider

Use this for Volcengine Ark, OpenRouter, Ollama, vLLM, private gateways, and similar services:

1. **Name** — for example `Volcengine`.
2. **id** — for example `volcengine`.
3. **Adapter** — `Custom · ChatCompletion`.
4. **Key** — the upstream provider key. For a keyless local endpoint, enter any non-empty placeholder so credential preflight can mark it ready.
5. **Base URL** — the upstream OpenAI-compatible API root, for example `https://ark.cn-beijing.volces.com/api/v3` or `http://localhost:11434/v1`.
6. **Auth header** — normally `Authorization`.
7. **Headers / Extra params** — optional JSON objects.

The provider key is stored on the server in `~/.llm-fusion-lite/.env`. It is not sent to the browser after saving.

### 4. Add models

Open **Setup → Models** and add at least one row:

| Field    | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| `id`     | Stable internal model id used by the panel and learned-strength store. |
| provider | The provider instance created in the previous step.                    |
| model    | The exact upstream model or endpoint id.                               |
| label    | Display name. If blank, Fusion falls back to `model`, then `id`.       |
| web      | Whether the model may use provider-native web search.                  |
| effort   | Provider reasoning effort when supported.                              |
| auto     | Include the model in adaptive panel selection.                         |

Then open **Setup → Settings**:

- Select an existing **Default judge**.
- Select an existing **Classifier model**.
- Set **Panel size** no larger than the number of usable models.
- Save settings.

For useful fusion, configure at least two models. One model still works, but provides no cross-model diversity.

### 5. Test Fusion in the browser

Open <http://localhost:8787/>. Expand **Settings** to verify that model names appear in both the explicit panel and Judge menus, then send a prompt.

CLI smoke test from source:

```bash
npm run fusion-lite -- "Compare optimistic and pessimistic locking"
```

After running `./scripts/install.sh`, the shorter command is available:

```bash
fusion-lite "Compare optimistic and pessimistic locking"
```

### 6. Configure the external Agent gateway

Open <http://localhost:8787/connect/> and set:

- **Base URL** — leave blank to publish `http://localhost:8787/v1`, or enter the public reverse-proxy URL.
- **Model name** — the single model name your Agent will request; default `fusion`.
- **API Key** — optional. Blank means no gateway authentication. A non-empty value protects `/v1` immediately.

The page shows copy-ready environment variables and JSON. A typical Agent configuration is:

```text
Base URL: http://localhost:8787/v1
API Key:  not-required
Model:    fusion
```

If you configure a gateway API key:

```text
Base URL: http://localhost:8787/v1
API Key:  YOUR_FUSION_API_KEY
Model:    fusion
```

Equivalent environment variables:

```bash
OPENAI_BASE_URL=http://localhost:8787/v1
OPENAI_API_KEY=YOUR_FUSION_API_KEY
OPENAI_MODEL=fusion
```

Generic JSON:

```json
{ "baseURL": "http://localhost:8787/v1", "apiKey": "YOUR_FUSION_API_KEY", "model": "fusion" }
```

If your Agent runs inside Docker, use:

```text
http://host.docker.internal:8787/v1
```

The gateway key accepts either `Authorization: Bearer <key>` or `X-API-Key: <key>`. It protects `/v1` only; keep the dashboard and `/api` on a trusted network or restrict them at your reverse proxy. Use HTTPS for remote access.

### 7. Verify with curl

No gateway API key:

```bash
curl http://localhost:8787/v1/models
```

With a gateway API key:

```bash
curl http://localhost:8787/v1/models \
  -H "Authorization: Bearer YOUR_FUSION_API_KEY"
```

Chat Completions:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FUSION_API_KEY" \
  -d '{"model":"fusion","messages":[{"role":"user","content":"Explain CRDTs briefly"}]}'
```

Omit the authorization header when gateway authentication is disabled.

## Other integration modes

### MCP

Build first, then point an MCP client at the local server executable:

```json
{
    "mcpServers": {
        "llm-fusion-lite": { "command": "node", "args": ["C:/path/to/llm-fusion/packages/cli/dist/mcp.js"] }
    }
}
```

See [docs/MCP.md](docs/MCP.md).

### `/fuse` skill

On macOS/Linux, `./scripts/install.sh` copies the skill to Claude Code and OpenCode. You can then run:

```text
/fuse Compare these two architectures
```

## Configuration and data

Default state directory: `~/.llm-fusion-lite/`

| File          | Purpose                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `config.json` | Providers, models, judge, panel settings, and external gateway configuration.               |
| `.env`        | Upstream provider keys. Treat as secret.                                                    |
| `fusion.db`   | Runs, learned model strengths, usage, and feedback. Treat prompts and answers as sensitive. |

Override the directory with `LLM_FUSION_LITE_HOME`.

The external gateway API key is stored only as a salted digest in `config.json`; the original plaintext is not recoverable from the UI.

## Troubleshooting

### The Judge menu or model panel is empty

- Confirm **Setup → Models** contains models.
- Ensure the model rows reference an existing provider.
- Save the Models section, then refresh Chat.
- Blank labels automatically fall back to the upstream model name or id.

### No models are available

- Check that the upstream provider key is set.
- For custom endpoints, verify the Base URL and exact upstream model id.
- Run `npm run fusion-lite -- doctor` and `npm run fusion-lite -- models`.

### `npm install -g llm-fusion-lite` returns 404

The package is not published yet. Use the source installation steps in this README.

### Port 8787 is already in use

Stop the existing process or set `LLM_FUSION_LITE_PORT` before starting the server.

### Agent receives 401

The gateway API key is enabled. Copy the current value you chose into your Agent and send it as a Bearer token. The UI intentionally shows only a masked hint after saving.

## Development

```bash
npm run build
npm test
npm run format
```

Workspace packages:

- `@llm-fusion-lite/core` — fusion engine, providers, judge, adaptive store.
- `@llm-fusion-lite/server` — Hono HTTP server and OpenAI-compatible gateway.
- `@llm-fusion-lite/cli` — CLI, setup wizard, MCP server.
- `@llm-fusion-lite/web` — React multi-page dashboard.

## License

[MIT](LICENSE) — fork of llm-fusion (Era Fusion), © Alexander Ollman.
