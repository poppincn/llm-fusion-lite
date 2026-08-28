<div align="center">

# LLM Fusion Lite

**并行调用多个大模型，融合成一个答案，再以单个 OpenAI 兼容模型接入你的 Agent。**

[English](README.md) · [许可证](LICENSE) · [Agentic 模式](docs/AGENTIC_FUSION.md) · [MCP](docs/MCP.md)

</div>

> LLM Fusion Lite 是 [llm-fusion](https://github.com/Alexander-Ollman/llm-fusion)（“Era Fusion”，© Alexander Ollman，MIT）的轻量化分支。它保留并行模型组、两阶段裁判、按主题学习模型实力、CLI、Web UI、MCP 服务和 `/fuse` skill。

## 你能得到什么

- **给 Agent 使用的单一融合模型**：兼容 OpenAI `POST /v1/chat/completions`。
- **灵活的供应商支持**：Anthropic、OpenAI、Google，以及火山方舟、OpenRouter、Ollama、vLLM、DeepSeek、Qwen 等 OpenAI Chat Completions 兼容服务。
- **Web 可视化配置**：供应商、模型、裁判、模型组规模、外部模型名、公开 Base URL 和可选 API Key。
- **热更新**：外部 Base URL、模型名称和 API Key 保存后立即对新请求生效。
- **稳定的多页地址**：`/`、`/strengths/`、`/usage/`、`/connect/`、`/setup/` 刷新后仍停留在当前页面。
- **自适应学习**：模型贡献度和用户反馈会逐步影响后续模型组选择。

## 当前发布状态

`llm-fusion-lite` **尚未发布到 npm**，请按下面的源码安装方式使用。要求 **Node.js 22 或更高版本**，推荐 Node.js 24+。

## 从安装到接入 Agent：完整流程

### 第 1 步：克隆并构建

```bash
git clone https://github.com/jamcaaxian/llm-fusion.git
cd llm-fusion
npm install
npm run build
```

macOS/Linux 可选：安装本地命令和 `/fuse` skill。

```bash
./scripts/install.sh
```

Windows 或未安装本地命令时，通过 npm script 使用 CLI：

```powershell
npm run fusion-lite -- doctor
```

### 第 2 步：启动 Web UI

```bash
npm run start --workspace=@llm-fusion-lite/server
```

打开：

- 设置供应商和模型：<http://localhost:8787/setup/>
- 获取 Agent 接入配置：<http://localhost:8787/connect/>
- 测试对话：<http://localhost:8787/>

修改端口：

```powershell
$env:LLM_FUSION_LITE_PORT = "9000"
npm run start --workspace=@llm-fusion-lite/server
```

```bash
LLM_FUSION_LITE_PORT=9000 npm run start --workspace=@llm-fusion-lite/server
```

### 第 3 步：添加供应商

打开 **设置 → 供应商 → 添加供应商**。

#### 官方供应商

选择 Anthropic、OpenAI 或 Google，填写：

1. **名称**：任意显示名称，例如 `OpenAI Production`。
2. **id**：稳定的内部标识，例如 `openai-prod`。
3. **适配器**：对应官方供应商。
4. **Key**：编辑时留空会保留当前值。

#### 自定义 OpenAI 兼容供应商

适用于火山方舟、OpenRouter、Ollama、vLLM、私有网关等服务：

1. **名称**：例如 `Volcengine`。
2. **id**：例如 `volcengine`。
3. **适配器**：选择 `自定义 · ChatCompletion`。
4. **Key**：上游供应商 API Key。无鉴权的本地服务也需填写任意非空占位值，供凭证预检判断为可用。
5. **Base URL**：上游 OpenAI 兼容 API 根地址，例如 `https://ark.cn-beijing.volces.com/api/v3` 或 `http://localhost:11434/v1`。
6. **认证头**：通常使用 `Authorization`。
7. **Headers / 附加参数**：可选 JSON 对象。

供应商 Key 会保存在服务器的 `~/.llm-fusion-lite/.env` 中，保存后不会再把明文返回浏览器。

### 第 4 步：添加模型

打开 **设置 → 模型**，至少添加一行：

| 字段   | 含义                                               |
| ------ | -------------------------------------------------- |
| `id`   | 模型组和学习数据库使用的稳定内部 ID。              |
| 供应商 | 第 3 步创建的供应商实例。                          |
| 模型   | 上游服务真实的模型名或 Endpoint ID。               |
| 标签   | UI 显示名；留空时自动回退到“模型”，再回退到 `id`。 |
| 联网   | 是否允许该模型使用供应商原生联网能力。             |
| 努力度 | 供应商支持时使用的推理努力度。                     |
| 自动   | 是否加入自适应模型组候选。                         |

然后打开 **设置 → 偏好设置**：

- **默认裁判**必须选择当前存在的模型。
- **分类模型**必须选择当前存在的模型。
- **模型组规模**不要大于可用模型数量。
- 保存设置。

建议至少配置两个模型，才能产生真正的跨模型融合；只配置一个模型也可以运行。

### 第 5 步：在网页测试融合

打开 <http://localhost:8787/>，展开“设置”，确认指定模型组和裁判下拉菜单都能看到模型名称，然后发送问题。

源码模式下的 CLI 冒烟测试：

```bash
npm run fusion-lite -- "比较乐观锁和悲观锁"
```

执行过 `./scripts/install.sh` 后可直接使用：

```bash
fusion-lite "比较乐观锁和悲观锁"
```

### 第 6 步：配置对外 Agent 网关

打开 <http://localhost:8787/connect/>，配置：

- **Base URL**：留空时自动使用 `http://localhost:8787/v1`；部署在反向代理后可填写公开地址。
- **模型名称**：Agent 请求时填写的单一模型名，默认 `fusion`。
- **API Key**：可选。留空表示不鉴权；填写后立即保护 `/v1`。

页面会生成可复制的字段、环境变量和 JSON。典型配置：

```text
Base URL: http://localhost:8787/v1
API Key:  not-required
Model:    fusion
```

启用网关 API Key 后：

```text
Base URL: http://localhost:8787/v1
API Key:  YOUR_FUSION_API_KEY
Model:    fusion
```

环境变量：

```bash
OPENAI_BASE_URL=http://localhost:8787/v1
OPENAI_API_KEY=YOUR_FUSION_API_KEY
OPENAI_MODEL=fusion
```

通用 JSON：

```json
{ "baseURL": "http://localhost:8787/v1", "apiKey": "YOUR_FUSION_API_KEY", "model": "fusion" }
```

如果 Agent 运行在 Docker 容器中，Base URL 通常使用：

```text
http://host.docker.internal:8787/v1
```

网关支持 `Authorization: Bearer <key>` 和 `X-API-Key: <key>`。该 Key 只保护 `/v1`；管理页面和 `/api` 应放在可信网络，或由反向代理限制访问。远程部署务必使用 HTTPS。

### 第 7 步：用 curl 验证

未设置网关 API Key：

```bash
curl http://localhost:8787/v1/models
```

已设置网关 API Key：

```bash
curl http://localhost:8787/v1/models \
  -H "Authorization: Bearer YOUR_FUSION_API_KEY"
```

调用 Chat Completions：

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FUSION_API_KEY" \
  -d '{"model":"fusion","messages":[{"role":"user","content":"简要解释 CRDT"}]}'
```

未启用网关鉴权时，删除 Authorization 请求头即可。

## 其他接入方式

### MCP

先完成构建，再让 MCP 客户端启动本地 MCP 服务：

```json
{
    "mcpServers": {
        "llm-fusion-lite": { "command": "node", "args": ["C:/你的路径/llm-fusion/packages/cli/dist/mcp.js"] }
    }
}
```

更多说明见 [docs/MCP.md](docs/MCP.md)。

### `/fuse` skill

macOS/Linux 执行 `./scripts/install.sh` 后，会把 skill 安装到 Claude Code 和 OpenCode。之后可使用：

```text
/fuse 比较这两个架构方案
```

## 配置与数据位置

默认状态目录：`~/.llm-fusion-lite/`

| 文件          | 用途                                                             |
| ------------- | ---------------------------------------------------------------- |
| `config.json` | 供应商、模型、裁判、模型组和对外网关配置。                       |
| `.env`        | 上游供应商 Key，属于敏感信息。                                   |
| `fusion.db`   | 运行记录、模型实力、用量和反馈；其中可能包含用户问题与模型答案。 |

可通过 `LLM_FUSION_LITE_HOME` 修改状态目录。

对外网关 API Key 只会以加盐摘要保存在 `config.json`，UI 无法恢复原始明文。

## 常见问题

### 裁判下拉菜单或指定模型组为空

- 确认 **设置 → 模型** 中已经有模型。
- 确认模型引用了存在的供应商。
- 保存模型后刷新“对话”页。
- 标签为空时会自动使用上游模型名或 `id`。

### 没有可用模型

- 检查上游供应商 Key 是否正确。
- 自定义服务需检查 Base URL 和真实模型 ID。
- 运行 `npm run fusion-lite -- doctor` 和 `npm run fusion-lite -- models`。

### `npm install -g llm-fusion-lite` 返回 404

npm 包尚未发布，请使用本 README 的源码安装方式。

### 8787 端口被占用

停止旧进程，或在启动前设置 `LLM_FUSION_LITE_PORT`。

### Agent 收到 401

说明已启用网关 API Key。将你设置的原始 Key 填入 Agent，并作为 Bearer Token 发送。保存后 UI 只会显示末四位掩码，这是预期行为。

## 开发与验证

```bash
npm run build
npm test
npm run format
```

Workspace：

- `@llm-fusion-lite/core`：融合引擎、供应商、裁判和自适应数据库。
- `@llm-fusion-lite/server`：Hono HTTP 服务与 OpenAI 兼容网关。
- `@llm-fusion-lite/cli`：CLI、配置向导和 MCP 服务。
- `@llm-fusion-lite/web`：React 多页控制台。

## 许可证

[MIT](LICENSE) — llm-fusion（Era Fusion）的分支，© Alexander Ollman。
