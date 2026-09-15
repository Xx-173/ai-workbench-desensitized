# 多 Agent 接入与治理工作台

> 基于 Craft Agents 的业务化扩展：把 Python 脚本、HTTP / Dify / Coze / Fish 工作流和 MCP Agent 接入同一工作台，由基座统一完成密钥引用、会话上下文、任务隔离与用量统计。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

这是 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) 的 Apache-2.0 增量扩展，不重新实现其 Agent Runtime、桌面端、Web 端或模型能力。Craft 底座提供会话、Agent 执行、Workspace、凭据管理与 MCP 生态；本仓库新增的业务层位于 [`business/agent-workbench`](business/agent-workbench)。完整的上游归属及修改声明见 [NOTICE](NOTICE)。

## 产品定位

课程视频、音色和文案只是首批可接入场景，不是产品边界。每一个接入都以受控 Manifest 说明名称、输入 Schema、调用形态、超时和**密钥引用名**；真实 Key、端点、项目 ID 和业务素材不进入代码库。

| Agent 类型 | 接入方式 | 常见场景 |
| --- | --- | --- |
| Python 脚本 | stdin 输入 JSON、stdout 输出 JSON；无 shell 执行，只注入声明过的凭据别名 | 话术清洗、结构化抽取、内部规则脚本 |
| HTTP Agent | 通用 JSON、Dify 工作流或 Coze 工作流载荷 | 视频解析、Fish 音色生成、文案生成、低代码 Agent |
| MCP Agent | 受控 stdio MCP 子进程，调用其声明的工具 | 其他框架、已有 MCP 服务、专用工具链 |

工作台将它们统一注册为可发现、可校验、可从 MCP 调用的工具。新增 Agent 通常只需新增一条配置，而不需要修改 Craft 的执行核心。

## 已实现能力

- **Manifest 校验与注册**：启动前校验 Agent ID、工具名、输入 Schema、凭据引用、超时与传输配置；拒绝重复工具名和不安全格式。
- **统一执行适配**：`agent-runtime.ts` 适配 HTTP、Python、MCP 三类 Agent；HTTP 内置通用、Dify 与 Coze 工作流载荷模式，Python/MCP 均禁止 shell。
- **密钥不落库**：运行时经 `CredentialReader` 获取引用，嵌入 Craft 时可复用其 Credential Manager；Python/MCP 子进程只拿到本 Agent 已声明的凭据别名。
- **隐私友好的用量账本**：每次执行记录 Agent 标识、类型、时长、成功/失败、输入/输出字节数及上游可选 token 数；不保存提示词、结果正文、端点或密钥。独立 MCP 服务默认写到 Workspace 的 `.agent-workbench/usage.jsonl`。
- **本地控制中心**：提供仅绑定回环地址的 Agent Control Center，可编辑和校验 Manifest、管理 AES-256-GCM 加密的本地 Key 引用、检查配置完整性，并展示调用、失败、时延、Token 和按配置规则估算的成本；页面不回显 Key。
- **执行策略**：每个 Agent 可配置有限次数重试、指数退避、滑动窗口限流以及日调用 / Token 配额。策略在运行时执行，持久化用量账本用于重启后的配额判断。
- **任务与访问边界**：每个任务独占 `inputs/`、`outputs/`、`tmp/`；路径越界被拒绝。账号冻结会使已签发凭据失效、关闭长连接、清理授权缓存并在调用前复核状态。
- **MCP 双向接线**：同一注册表既可被宿主进程直接调用，也可通过 stdio MCP 服务对外暴露；工作台还能以 MCP Client 调用其他 Agent。

仓库保留了音色生成、视频解析、话术清洗、文本质检、文案生成五个首批业务样例。它们用于展示接入及任务隔离方式，不等同于自研模型或已经部署的第三方服务。

## 配置与运行

需要 Node.js 22.6 或更高版本。业务包不进入 Craft 的 Bun workspace，因此不会改动上游锁文件。

```bash
cd business/agent-workbench
npm ci
npm test
```

复制 [`config/agents.example.json`](business/agent-workbench/config/agents.example.json) 到仓库外的受控路径，按你的密钥管理方案填入**引用名或部署配置**，不要提交实际 Key。示例含视频解析、Fish 兼容音色、Python 话术清洗、Dify 文案和外部 MCP Agent。

以独立 MCP 服务加载该配置：

```bash
cd business/agent-workbench
npm run serve:mcp -- --session-id demo-1 --workspace-root /absolute/path/to/workspace --agents-config /safe/path/agents.json
```

不带 `--agents-config` 时，服务仍提供仓库内五个示例工具；带 Manifest 可选择 `includeBuiltinAgents: false`，只暴露你的业务 Agent。当前测试为 78 个用例，覆盖注册、三类 Agent 适配、凭据缺失、加密密钥库、控制中心、重试/限流/配额、用量脱敏、MCP 调用、任务隔离、降级和访问撤销。

### 启动本地控制中心

控制中心默认只监听 `127.0.0.1:4318`，管理状态位于指定 Workspace 的 `.agent-workbench/`。先生成并妥善保管一个 32 字节 Base64 主密钥；它不应写入配置文件或提交到仓库。

```powershell
$env:AGENT_WORKBENCH_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
cd business/agent-workbench
npm run serve:control -- --workspace-root D:\safe\agent-workspace
```

打开 `http://127.0.0.1:4318` 后可粘贴或编辑 Manifest、设置 Dify / Fish / Coze 等的地址和 Key 引用值、配置重试/限流/配额/价格规则，并运行“配置完整性检查”。该检查不会自动请求第三方供应商。

让 MCP Server 读取同一份 Manifest 与加密 Key 库：

```powershell
npm run serve:mcp -- --session-id demo-1 --workspace-root D:\safe\agent-workspace --agents-config D:\safe\agent-workspace\.agent-workbench\agents.json --secret-store D:\safe\agent-workspace\.agent-workbench\secrets.enc.json
```

控制中心更新 Manifest 后，MCP Server 在下一次 `tools/list` 或 `tools/call` 时重新加载配置；Key 库同样按每次调用读取，不需要重启服务。

## 当前边界

- 控制中心是独立的本地页面，刻意不修改 Craft 原生 UI；若要嵌入 Craft 的桌面端 / Web 端，需要额外修改上游 `apps/` 并重新界定维护边界。
- Dify、Coze、Fish 等仅提供协议适配、配置入口和本地配置完整性检查，不包含真实工作流、账户、端点、素材或已验证的生产连通性。
- 用量账本提供调用与 token 聚合、基础成本估算、重试/限流/日配额规则；多租户计费、供应商价格同步、分布式限流和告警仍需结合部署环境继续建设。
- 本仓库提供代码与测试级验证，不主张生产规模、业务指标、自研大模型或 Craft 底座本身的能力归属。

## 目录

```text
business/agent-workbench/
├── src/          # Manifest、运行时、用量账本、任务隔离与访问撤销
├── adapter/       # MCP Server、宿主上下文与事件契约适配
├── config/        # 只含占位符的 Agent 配置模板
└── README.md      # 模块级接入及安全说明
```

## 许可证与上游

本仓库遵循 [Apache-2.0](LICENSE)。Craft Agents 的版权声明、许可证和本项目的修改通知均保留在 [NOTICE](NOTICE) 中。除根目录说明和元数据外，业务改动集中在 `business/agent-workbench/`；上游的 `apps/` 与 `packages/` 源代码没有因业务层接入而修改。
