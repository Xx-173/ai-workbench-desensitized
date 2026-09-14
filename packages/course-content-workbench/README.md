# 课程内容 AI 提效工作台 · 业务层

> **本项目是 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss)（Apache-2.0，Craft Docs Ltd. 出品）的业务化改造版本。**
> 底座提供 Agent 运行时、多端架构、MCP 接入、事件契约与 server-core 服务化封装；本目录是**在其之上新增的业务层**，不修改底座任何一行代码。

---

## 一、这条边界很重要

| | 归属 |
| --- | --- |
| Agent 运行时、多端（Electron / WebUI / CLI / Server）架构 | 底座提供 |
| `SessionToolContext` 上下文注入、`AgentEvent` 事件契约、`server-core` 服务化封装 | 底座提供 |
| Claude Agent SDK / Pi Agent **双后端**事件适配 | 底座提供 |
| **多来源 AI 能力的接入登记层** | **本目录新增** |
| **视频章节聚合 + 规则回退** | **本目录新增（自研业务逻辑）** |
| **素材与任务的业务对象隔离** | **本目录新增（复用底座 Session/Workspace 模型）** |
| **账号管理与三层访问撤销** | **本目录新增（自研业务层）** |

改这个件事的方式是**纯增量**：新增一个 `packages/` 包、零外部依赖、不触碰 `bun.lock`。这既是"不改动 Agent 执行核心"的证据，也让本地 `git log` 里业务提交与上游提交泾渭分明。

---

## 二、模块清单

| 文件 | 职责 | 对应能力点 |
| --- | --- | --- |
| `src/capability-registry.ts` | 能力注册表 + 入参结构校验。**新增一类 AI 能力只需在 `capabilities.ts` 加一条** | 多来源能力的登记与复用 |
| `src/capabilities.ts` | 五类能力的声明式登记：音色克隆、视频解析、话术清洗、文字质检、文案生成 | 同上 |
| `src/video-chapters.ts` | 转写分段 → 开场/知识内容/营销/收尾章节；模型失败时按时间均分回退 | 长任务的确定性输出 |
| `src/task-workspace.ts` | 每个任务一份 `inputs/ outputs/ tmp/`，路径越界直接拒绝 | 素材与任务隔离 |
| `src/account-revocation.ts` | 凭据层 / 连接层 / 执行层三层访问撤销 | 冻结立即生效 |
| `src/business-events.ts` | 长任务进度与错误的结构化事件 | 错误态可驱动前端恢复 |
| `src/remote.ts` | 第三方服务调用；**配置缺失即失败，不静默兜底** | 外部服务接入 |

---

## 三、三个值得看的设计点

### 1. 章节聚合永远给你四个章节

模型是不可靠参与者：会抛错、会超边界、会漏掉一个 section、会出现区间重叠。天真地信任它的输出，结果就是**模型一出错，结果页连板块结构都没有**。

所以这里的契约是：**调用方永远拿到四个有序章节**——要么来自模型，要么来自时间均分规则。没有第三种状态。

```ts
const result = await buildChapters(segments, { groupByModel, pageHints, timeoutMs: 10_000 });
// result.source: 'model' | 'rule-fallback'
// result.reason: 'model-threw' | 'missing-sections' | 'out-of-bounds' | 'non-monotonic' | ...
```

### 2. 冻结为什么必须做三层

账号冻结真正难的不是"禁止某个动作"，而是**"已经冻结了却没生效"**。一次冻结之后，下面三样东西仍然能继续干活：

| 层 | 还漏什么 | 怎么堵 |
| --- | --- | --- |
| 凭据层 | 已签发、尚未过期的会话凭据 | `status_version` 参与 HMAC 签名；冻结即 `+1`，旧凭据**验签直接失败**，不需要吊销列表 |
| 连接层 | 建连时鉴权过、之后长期存活的长连接 | `AccountConnectionRegistry` 按 `accountId` 索引，冻结时遍历并以 `1008` 主动断开 |
| 执行层 | 内存里从未失效的缓存授权状态 | 每次工具调用前重读状态，读不到即拒绝（fail-closed） |

执行层每次读库有成本，所以取的是**有界陈旧**（短 TTL + 冻结时显式清缓存），而不是长缓存。撤销延迟是安全属性、吞吐是性能属性，冲突时优先前者。

还有个顺序细节藏在 `revokeAccess()` 里：**先抬版本号，再断连接**。反过来做的话，客户端可能在两者之间的窗口里带着旧凭据重连成功。

### 3. 业务逻辑不依赖真实模型就能测

本包所有外部能力都通过 `ports.ts` 里的窄接口进入（依赖注入），因此 `video-chapters` 可以用一个必然抛错的假模型来测降级路径——测的是**业务逻辑本身**，而不是"模型今天心情好不好"。

---

## 四、脱敏说明

这个仓库**不含任何真实数据**：

- 没有真实端点 / 密钥 / 项目 ID —— 全部来自注入式 `CredentialReader`，配置模板见 `config/capabilities.example.json`，占位符统一为 `https://REPLACE_ME.invalid` 与 `REPLACE_ME`
- 没有真实人名、账号名、课程名、音视频文件 —— 测试夹具全是合成数据（`src/__tests__/fixtures.ts`）
- 配置缺失时的行为是**大声失败并列出缺哪些占位变量名**，而不是悄悄路由到某个默认地址

---

## 五、运行

```bash
cd packages/course-content-workbench
npm test          # 需要 Node >= 22.6，直接用内置 type stripping 跑 .ts
```

38 个测试，覆盖：登记表的增删改查与入参校验、五种降级路径的行为、路径穿越防护、三层撤销各自的独立性与组合顺序。

> 不需要 `bun install`。这个包**零外部依赖**，刻意不动底座的依赖图与 `bun.lock`。

---

## 六、许可与归属

- 上游：**Apache-2.0**，Copyright 2026 Craft Docs Ltd. —— 见仓库根目录 [`LICENSE`](../../LICENSE) 与 [`NOTICE`](../../NOTICE)
- 本目录同样以 Apache-2.0 提供；根目录 `NOTICE` 已按 Apache-2.0 §4(d) 追加了修改声明
- 音色克隆、视频解析、低代码工作流均为**第三方服务接入，非自研模型**
