# 多 Agent 接入与治理工作台 · 业务层

> **这是在 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) 上新增的业务层，不改动其 Agent Runtime。**
> 它将不同实现形态的 Agent 统一纳入一个受控注册、凭据引用和用量统计平面。

## 归属边界

| 能力 | 归属 |
| --- | --- |
| 会话、Workspace、Agent Runtime、多端架构、内置模型连接 | Craft 底座 |
| 结构化 Session 上下文、凭据管理接口、Agent 事件契约 | Craft 底座 |
| Agent Manifest、输入校验、HTTP / Python / MCP 执行适配 | 本业务层新增 |
| 按 Agent 显式引用凭据、受限子进程环境、用量 JSONL 账本 | 本业务层新增 |
| 任务产物隔离、章节聚合规则回退、访问撤销 | 本业务层新增 |

业务层位于根目录 `business/agent-workbench/`，刻意不加入 `packages/*` 或 `apps/*` workspace，以避免把业务依赖写进上游 `bun.lock`。它通过结构化类型、MCP 和守卫测试与底座接线，而不是修改底座的内置工具数组。

## Agent 接入合同

每个 Agent 在受控 JSON Manifest 中登记：`id`、`toolName`、输入 Schema、类型、超时、凭据引用和传输配置。启动前会拒绝重复 ID/工具名、非法标识和不完整的结构。

| `kind` | 运行方式 | 密钥处理 |
| --- | --- | --- |
| `http` | `input`、`dify-workflow`、`coze-workflow` 三种 JSON 载荷 | 基座按 `baseUrlEnv` / `tokenEnv` 引用读取，缺失即失败 |
| `python` | 管理员指定脚本从 stdin 接收 JSON、向 stdout 输出一个 JSON 值 | 仅通过 `credentials` 显式映射给子进程；`shell: false` |
| `mcp` | 作为 stdio MCP Client 启动受控外部服务并调用其工具 | 同样只注入显式凭据别名；`shell: false` |

`config/agents.example.json` 是不含真实值的模板，演示视频、Fish 兼容音色、Python 清洗、Dify 文案和外部 MCP Agent。Coze 可使用 `coze-workflow` 载荷；任何支持 HTTP JSON 的框架也可以使用通用 `input` 载荷。

## 用量与隐私

`usage-ledger.ts` 记录的是：Agent 标识、类型、时间、耗时、成功/失败、输入/输出字节数，以及上游响应中的可选 token 数。不会记录 prompts、结果正文、URL、API Key 或账户标识。

独立 MCP 服务会把账本写在 `<workspace>/.agent-workbench/usage.jsonl`。嵌入 Craft 时，宿主可将自己的 `UsageRecorder` 传入运行时并同步到其监控或数据库；成本与配额规则仍应由部署方基于实际供应商价格实现。

## 运行

```bash
cd business/agent-workbench
npm ci
npm test

# 将模板复制到仓库外、填入你自己的安全配置后启动
npm run serve:mcp -- --session-id demo-1 --workspace-root /absolute/path/to/workspace --agents-config /safe/path/agents.json
```

`--agents-config` 可选；不传时保留五个首批示例工具。传入配置时可设置 `includeBuiltinAgents: false`，使 `tools/list` 只返回当前业务配置的 Agent。

## 现有模块

| 文件 | 职责 |
| --- | --- |
| `src/agent-manifest.ts` | 解析和校验管理员控制的 Agent 配置 |
| `src/agent-runtime.ts` | HTTP、Python、MCP 执行适配与显式凭据注入 |
| `src/usage-ledger.ts` | 无原文的调用统计、内存与 JSONL 实现 |
| `src/capability-registry.ts` | 工具发现、输入校验和统一调用面 |
| `src/capabilities.ts` | 音色、视频、清洗、质检、文案五个示例实现 |
| `src/task-workspace.ts` | 任务级 `inputs/outputs/tmp` 隔离与路径防穿越 |
| `src/account-revocation.ts` | 凭据、连接、执行三层撤销 |
| `adapter/mcp-server.ts` | stdio MCP Server 与 Manifest 装载 |
| `adapter/session-context-bridge.ts` | Craft Session / Credential Manager 的窄适配 |

测试使用合成数据，不连接真实服务。目前 70 个测试覆盖 Manifest 校验、三种接入形态、凭据缺失、使用量脱敏、MCP、任务隔离、章节降级和上游契约。

## 脱敏与许可证

仓库不包含真实 API Key、端点、项目 ID、音视频、提示词或用户数据。配置缺失时会明确列出缺少的引用名，不会回落到默认服务。

上游遵循 Apache-2.0，版权与修改声明见根目录 [`LICENSE`](../../LICENSE) 和 [`NOTICE`](../../NOTICE)。第三方 Agent 服务并非本仓库自研模型。
