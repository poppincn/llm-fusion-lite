# LLM Fusion Lite — Engineer Onboarding

This document is the maintainer-oriented companion to the end-user guides:

- [English installation and Agent integration](../README.md)
- [简体中文安装与 Agent 接入](../README.zh-CN.md)

## Current distribution state

The npm package is not published yet. Use the source workflow:

```bash
git clone https://github.com/jamcaaxian/llm-fusion.git
cd llm-fusion
npm install
npm run build
npm run start --workspace=@llm-fusion-lite/server
```

Optional on macOS/Linux:

```bash
./scripts/install.sh
```

## Operator workflow

1. Open <http://localhost:8787/setup/>.
2. Add provider instances and their keys.
3. Add models using exact upstream model or Endpoint IDs.
4. Select existing models for the default judge and classifier.
5. Test a fusion at <http://localhost:8787/>.
6. Open <http://localhost:8787/connect/> and copy the Base URL, API Key, and model name into the target Agent.

Provider keys are stored in `~/.llm-fusion-lite/.env`. Provider instance Key environment-variable names are internal implementation details and are not exposed in the Web UI.

## State and security

| Path                             | Contents                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| `~/.llm-fusion-lite/config.json` | Providers, models, panel settings, and external gateway settings. |
| `~/.llm-fusion-lite/.env`        | Upstream provider credentials.                                    |
| `~/.llm-fusion-lite/fusion.db`   | Runs, usage, model strengths, prompts, answers, and feedback.     |

The external gateway API key protects `/v1` only. Keep the dashboard and `/api` on a trusted network or restrict them with a reverse proxy. Use HTTPS for remote deployments.

## Verification

```bash
npm test
npm run fusion-lite -- doctor
npm run fusion-lite -- models
```

Direct page smoke tests:

- <http://localhost:8787/>
- <http://localhost:8787/strengths/>
- <http://localhost:8787/usage/>
- <http://localhost:8787/connect/>
- <http://localhost:8787/setup/>

## Publishing

The future npm publishing workflow is documented separately in [PUBLISHING.md](PUBLISHING.md). Do not advertise `npm install -g llm-fusion-lite` as an available installation method until the package is actually published.
