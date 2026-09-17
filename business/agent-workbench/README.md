# 多 Agent 接入与治理工作台 · 业务层

> **这是在 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) 上新增的业务层；它通过最小 WebUI / Server 接线成为 Craft 内的原生“AI 工作台”，不改动其 Agent Runtime。**
> 它将不同实现形态的 Agent 统一纳入一个受控注册、凭据引用和用量统计平面。

## 归属边界

| 能力 | 归属 |
| --- | --- |
| 会话、Workspace、Agent Runtime、多端架构、内置模型连接 | Craft 底座 |
| 结构化 Session 上下文、凭据管理接口、Agent 事件契约 | Craft 底座 |
| Agent Manifest、输入校验、HTTP / Python / MCP 执行适配 | 本业务层新增 |
| 按 Agent 显式引用凭据、受限子进程环境、用量 JSONL 账本 | 本业务层新增 |
| 任务产物隔离、章节聚合规则回退、访问撤销、结果映射 | 本业务层新增 |
| Trace/Benchmark、无原文 Case Memory、外部 Agent 沙箱验证流程 | 本业务层新增 |
| 工作台导航、WebUI 团队认证和受控 HTTP API 挂载 | 本项目对 Craft WebUI / Server 的最小接线修改 |

业务层位于根目录 `business/agent-workbench/`，刻意不加入 `packages/*` 或 `apps/*` workspace，以避免把业务依赖写进上游 `bun.lock`。它通过结构化类型、MCP 和守卫测试与底座接线，而不是修改底座的内置工具数组。

## Agent 接入合同

每个 Agent 在受控 JSON Manifest 中登记：`id`、`toolName`、输入 Schema、类型、超时、凭据引用和传输配置。启动前会拒绝重复 ID/工具名、非法标识和不完整的结构。

| `kind` | 运行方式 | 密钥处理 |
| --- | --- | --- |
| `http` | `input`、`dify-workflow`、`coze-workflow` 三种 JSON 载荷 | `managed` 按 `baseUrlEnv` / `tokenEnv` 引用读取；`external`/`none` 不注入 Token，缺失配置即失败 |
| `python` | 管理员指定脚本从 stdin 接收 JSON、向 stdout 输出一个 JSON 值 | 仅通过 `credentials` 显式映射给子进程；`shell: false` |
| `mcp` | 作为 stdio MCP Client 启动受控外部服务并调用其工具 | 同样只注入显式凭据别名；`shell: false` |

`config/agents.example.json` 是不含真实值的模板，演示视频、Fish 兼容音色、Python 清洗、Dify 文案和外部 MCP Agent。Coze 可使用 `coze-workflow` 载荷；任何支持 HTTP JSON 的框架也可以使用通用 `input` 载荷。

每个 Manifest 可带 `policy`：`retry`（最多 5 次、指数退避）、`rateLimit`（滑动窗口）、`quota`（每日调用 / Token）和 `cost`（每百万 Token 的估算价格）。策略由运行时执行；用量 JSONL 为日配额和看板提供持久化事实。

## Eval、Case Memory 与隐私

`video-chapter-eval.ts` 将固定合成转写分别喂给“模型抛错”“缺章节”和“合法模型输出”三个场景，并断言：失败时必须回退为四段连续章节、合法结果才可采用模型输出。`npm run eval:video-chapters` 会生成可上传的 JSON Trace/Benchmark；Trace 仅包含用例 ID、来源、回退原因、章节顺序和断言结果，不包含转写正文。

`case-memory.ts` 将成功调用和失败类型沉淀为可选的 JSONL Case Memory：同一输入只存 SHA-256 指纹、字节数、耗时、重试次数和处理策略，例如 `request-admin-configure-credential`、`wait-for-rate-limit-window`。它不是响应缓存，绝不记录或复用 prompt、模型返回、URL、Key；这样既能形成运维案例库，也不会把业务正文带入观测数据。

`usage-ledger.ts` 记录的是：Agent 标识、类型、时间、耗时、成功/失败、输入/输出字节数，以及上游响应中的可选 token 数。经团队工作台发起的调用额外记录账号 ID 和部门 ID，以便只做部门/个人聚合；不会记录 prompts、结果正文、URL 或 API Key。

独立 MCP 服务会把账本写在 `<workspace>/.agent-workbench/usage.jsonl`，并把 Case Memory 写在同目录 `case-memory.jsonl`。嵌入 Craft 时，宿主可将自己的 `UsageRecorder` / `CaseMemoryRecorder` 传入运行时并同步到其监控或数据库；成本与配额规则仍应由部署方基于实际供应商价格实现。

## Craft 原生工作台与团队模式

启用 `CRAFT_TEAM_MODE=true` 后，Craft WebUI 登录改为管理员开通的“用户名 + 密码”。账号密码使用 scrypt 加盐哈希，浏览器使用 HttpOnly / SameSite 会话 Cookie；每次 HTTP 请求和新的 WebSocket 握手都会校验账号仍处于启用状态。浏览器仍加载 Craft 原生对话、会话与 Workspace；管理员可在左侧“AI 工作台”内维护部门、创建/禁用人员账号、查看部门/个人/Agent 聚合用量，并安全配置 Agent；普通成员只显示获授权 Agent 和自己的用量。管理员还能测试、启用/禁用和删除已发布 Agent；测试调用默认标记为 `admin_test`，可在团队用量 API 通过 `includeTests=true` 审计。

团队目录默认是单 Craft Server 实例的受限权限 JSON 文件，方便本地/单机演示。生产多实例部署应以实现相同接口的 PostgreSQL / 企业 SSO 替换，并经由 HTTPS/WSS 反向代理提供浏览器访问。

## 本地 Control Center

`adapter/control-center-server.ts` 提供本地 Web 控制台，默认监听 `127.0.0.1:4318`。它管理独立的 Manifest JSON 和 `secrets.enc.json`：后者通过 `AGENT_WORKBENCH_MASTER_KEY` 使用 AES-256-GCM 加密，页面只显示引用名和“已配置”状态，不会回显值。

```powershell
$env:AGENT_WORKBENCH_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
cd business/agent-workbench
npm run serve:control -- --workspace-root D:\safe\agent-workspace
```

控制中心提供：Manifest 编辑/校验、Dify / Fish / Coze 等配置引用录入、配置完整性检查、重试/限流/配额/成本策略编辑，以及无原文用量看板。其健康检查只核验本地配置与引用完整性，不会在没有明确用户操作的情况下向第三方发送请求。

Manifest 可选 `access` 字段，用于服务端授权：

```json
"access": { "departmentIds": ["部门 ID"], "roles": ["member"] }
```

它不是前端筛选：运行时会在列出 Agent 与调用 Agent 两处执行相同校验。管理员总可管理和审计；Token 数据只在被调用服务返回 usage 时记录。

将 MCP Server 指向同一状态目录：

```powershell
npm run serve:mcp -- --session-id demo-1 --workspace-root D:\safe\agent-workspace --agents-config D:\safe\agent-workspace\.agent-workbench\agents.json --secret-store D:\safe\agent-workspace\.agent-workbench\secrets.enc.json
```

MCP Server 在每次 `tools/list` / `tools/call` 时读取最新 Manifest，在调用时读取 Key 库，因此控制中心的更新无需重启 MCP Server。

## 运行

```bash
cd business/agent-workbench
npm ci
npm test
npm run typecheck
npm run eval:video-chapters -- --out artifacts/video-chapter-eval.json

# 将模板复制到仓库外、填入你自己的安全配置后启动
npm run serve:mcp -- --session-id demo-1 --workspace-root /absolute/path/to/workspace --agents-config /safe/path/agents.json
```

`--agents-config` 可选；不传时保留五个首批示例工具。传入配置时可设置 `includeBuiltinAgents: false`，使 `tools/list` 只返回当前业务配置的 Agent。

GitHub Actions 中的 **Agent Workbench Evidence** 工作流会执行类型检查、全部合成测试，并上传上述红线回退评测报告。真实 Dify 沙箱不会自动在 CI 中请求；需要部署方有意识地按 [`docs/external-agent-sandbox.md`](docs/external-agent-sandbox.md) 提供最小权限临时凭据后执行验证。

## 现有模块

| 文件 | 职责 |
| --- | --- |
| `src/agent-manifest.ts` | 解析和校验管理员控制的 Agent 配置 |
| `src/agent-runtime.ts` | HTTP、Python、MCP 执行适配与显式凭据注入 |
| `src/usage-ledger.ts` | 无原文的调用统计、内存与 JSONL 实现 |
| `src/case-memory.ts` | 无原文成功/失败案例记忆、处理策略与 JSONL 制品 |
| `src/video-chapter-eval.ts` | 固定输入章节降级 Trace / Benchmark |
| `src/secret-vault.ts` | AES-256-GCM 本地密钥库；仅返回配置状态 |
| `src/control-plane.ts` | Manifest、密钥状态与用量/成本看板的控制面 |
| `src/result-mapper.ts` | 安全映射不同 Agent 返回的文本、文件链接和结构化结果 |
| `src/team-directory.ts` | 管理员开通账号、部门、密码哈希与禁用状态的单实例目录 |
| `src/execution-governor.ts` | 重试、限流、日调用 / Token 配额执行器 |
| `src/capability-registry.ts` | 工具发现、输入校验和统一调用面 |
| `src/capabilities.ts` | 音色、视频、清洗、质检、文案五个示例实现 |
| `src/task-workspace.ts` | 任务级 `inputs/outputs/tmp` 隔离与路径防穿越 |
| `src/account-revocation.ts` | 凭据、连接、执行三层撤销 |
| `adapter/mcp-server.ts` | stdio MCP Server 与 Manifest 装载 |
| `adapter/team-workbench.ts` | Web 团队认证、已鉴权执行和部门/个人用量 API |
| `adapter/session-context-bridge.ts` | Craft Session / Credential Manager 的窄适配 |

测试使用合成数据，不连接真实服务。测试覆盖 Manifest 校验、三种接入形态、凭据缺失、加密密钥库、控制中心、结果映射、团队目录、团队鉴权 API、重试/限流/配额、使用量与 Case Memory 脱敏、MCP、任务隔离、章节降级和上游契约。

## 脱敏与许可证

仓库不包含真实 API Key、端点、项目 ID、音视频、提示词或用户数据。配置缺失时会明确列出缺少的引用名，不会回落到默认服务。

上游遵循 Apache-2.0，版权与修改声明见根目录 [`LICENSE`](../../LICENSE) 和 [`NOTICE`](../../NOTICE)。第三方 Agent 服务并非本仓库自研模型。
