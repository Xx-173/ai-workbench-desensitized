# 多 Agent 接入与治理工作台

> 基于 Craft Agents 的业务化扩展：把 Python 脚本、HTTP / Dify / Coze / Fish 工作流和 MCP Agent 接入同一工作台，由基座统一完成密钥引用、会话上下文、任务隔离与用量统计。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

这是 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) 的 Apache-2.0 增量扩展，不重新实现其 Agent Runtime 或模型能力。Craft 底座提供会话、Agent 执行、Workspace、凭据管理、MCP 生态和 WebUI；本项目在其 WebUI 中加入了受控的“AI 工作台”入口，并把业务层放在 [`business/agent-workbench`](business/agent-workbench)。完整的上游归属及修改声明见 [NOTICE](NOTICE)。

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
- **结果映射**：统一提取 HTTP / Dify / Coze / Python / MCP 返回中的可读文本与文件链接，同时递归遮盖疑似 Token、API Key、密码等字段；Craft 对话和工作台不会再只看到“Agent completed”。
- **隐私友好的用量账本**：每次执行记录 Agent 标识、类型、时长、成功/失败、输入/输出字节数及上游可选 token 数；Web 工作台调用还会记录不可逆的账号 ID 与部门 ID 维度，不保存提示词、结果正文、端点或密钥。
- **Craft 原生工作台与团队后台**：浏览器与桌面端共用 Craft 的对话、会话和 Workspace；左侧“AI 工作台”是同一界面内的业务入口，而非替代 Craft 的独立门户。成员可直接调用获授权 Agent、查看“我的用量”；管理员额外可开通/禁用账号、维护部门、查看部门/个人/Agent 聚合用量、编辑 Manifest，并录入 AES-256-GCM 加密的 Key 引用。页面不会回显 Key。
- **执行策略**：每个 Agent 可配置有限次数重试、指数退避、滑动窗口限流以及日调用 / Token 配额。策略在运行时执行，持久化用量账本用于重启后的配额判断。
- **可展示的质量证据**：固定合成输入的章节降级 Trace/Benchmark 断言模型失败仍返回连续四章节；Case Memory 以不可逆指纹沉淀成功调用与失败处理策略，避免把业务正文写入观测数据。独立 GitHub Actions 会执行 TypeScript 检查、合成测试并上传脱敏评测制品。
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

管理员可以在 Craft 的“AI 工作台 → Agent 配置”内加密录入 `DIFY_API_KEY`、`FISH_API_KEY` 等下游 Agent 凭据，再在 Manifest 中只引用其名称。组织默认聊天模型及其 Key 则由管理员在 Craft“设置 → AI”中配置；成员只接收该默认模型的只读信息，不能改写连接或模型。若要限定某项能力的部门或角色，在 Agent 项目中声明：

```json
"access": {
  "departmentIds": ["部门 ID"],
  "roles": ["member"]
}
```

该限制会同时作用于 Agent 列表与调用接口；即使成员绕过前端直接请求，服务端仍会拒绝未授权调用。管理员始终保留配置与审计权限。

以独立 MCP 服务加载该配置：

```bash
cd business/agent-workbench
npm run serve:mcp -- --session-id demo-1 --workspace-root /absolute/path/to/workspace --agents-config /safe/path/agents.json
```

不带 `--agents-config` 时，服务仍提供仓库内五个示例工具；带 Manifest 可选择 `includeBuiltinAgents: false`，只暴露你的业务 Agent。当前业务层测试为 81 个用例，覆盖注册、三类 Agent 适配、凭据缺失、加密密钥库、控制中心、结果脱敏映射、团队目录、团队鉴权 API、重试/限流/配额、用量脱敏、MCP 调用、任务隔离、降级和访问撤销。

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

### 以浏览器部署团队工作台

Craft 已有浏览器 WebUI，因此公司成员**不需要安装桌面客户端**：部署 server 与 WebUI 后，用浏览器访问服务地址即可。团队模式使用管理员创建的账号，而不是共享的 `CRAFT_SERVER_TOKEN`；未开通或已禁用的账号不能通过 HTTP 和新的 WebSocket 握手。

首次部署需准备 HTTPS / WSS、持久化目录和两个保密环境变量。以下只演示变量形态，真实值应由部署平台的 Secret Manager 注入：

```powershell
$env:CRAFT_TEAM_MODE = 'true'
$env:CRAFT_TEAM_ADMIN_USERNAME = 'admin'
$env:CRAFT_TEAM_ADMIN_PASSWORD = '<至少 10 位的初始管理员密码>'
$env:CRAFT_SERVER_TOKEN = '<随机会话签名密钥>'
$env:AGENT_WORKBENCH_MASTER_KEY = '<base64 编码的 32 字节主密钥>'
$env:AGENT_WORKBENCH_ROOT = 'D:\safe\craft-agent-workbench'

# 构建 WebUI 后，以反向代理 HTTPS/WSS 的方式运行 Craft Server
bun run server:prod
```

`AGENT_WORKBENCH_ROOT` 下会保留加密 Key 库、Manifest、团队目录、无原文用量 JSONL 和无原文 Case Memory JSONL；单实例演示默认用受限权限 JSON 文件持久化。成员只能看到自己的调用与按 Agent 聚合；管理员可查看部门、人员和 Agent 聚合。Token 仅在下游服务返回 usage 时入账，不会用估算值伪造。生产多实例需要把团队目录/用量账本替换为 PostgreSQL 等共享存储，并在反向代理层强制 HTTPS/WSS。

团队模式不会向员工展示 Craft 的“创建或选择 Workspace”流程。员工首次登录时，服务端会按其不可变的部门 ID 与成员 ID 自动分配一个独立 Workspace；普通成员只能列出、使用该 Workspace，不能新建、切换或配置远程 Workspace。部门仍是 Agent 授权和用量汇总维度，而不是多人共用的文件目录，因此成员的会话与文件保持隔离。管理员保留工作台控制台、组织模型配置、Agent 配置和跨部门用量分析权限。

### 真实外部 Agent 沙箱验收

仓库提供 Dify/Coze 的协议适配与完整的本地配置检查，但不会把未拿到部署方凭据的服务写成“已连通”。当你有最小权限 Dify 沙箱 Key 时，可按 [`business/agent-workbench/docs/external-agent-sandbox.md`](business/agent-workbench/docs/external-agent-sandbox.md) 运行一次真实工作流调用；脚本只落地耗时、输入指纹、返回大小和结果字段名等脱敏验收制品，不会提交凭据或业务内容。

## 当前边界

- “AI 工作台”已经嵌入 Craft 的共享 React AppShell，浏览器 WebUI 与桌面端都能看到入口；团队鉴权与工作台 API 只在启用 `CRAFT_TEAM_MODE` 的服务器上可用。桌面端本地打开该页时若没有对应服务器 API，会明确提示改用已部署的 WebUI。
- Dify、Coze、Fish 等仅提供协议适配、配置入口和本地配置完整性检查；真实连通须由部署方按沙箱验收流程执行并保存制品，不包含真实工作流、账户、端点或素材。
- 用量账本提供调用与 token 聚合、部门/个人维度、基础成本估算、重试/限流/日配额规则；多租户计费、供应商价格同步、分布式限流、立即断开已建立的 WebSocket 和告警仍需结合生产部署继续建设。
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

本仓库遵循 [Apache-2.0](LICENSE)。Craft Agents 的版权声明、许可证和本项目的修改通知均保留在 [NOTICE](NOTICE) 中。本项目还对 Craft 的 `apps/electron`、`apps/webui` 和 `packages/server*` 做了最小必要的导航、登录和受控 API 接线修改；其他上游运行时能力仍归 Craft 底座。
