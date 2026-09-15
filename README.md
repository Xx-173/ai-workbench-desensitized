# 课程内容 AI 工作台

> 面向课程内容生产的 AI 业务工作台：将课程素材处理能力封装为可调用工具，并通过 MCP 接入既有 Agent 主机。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

这是一个基于 [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss) 的 Apache-2.0 增量扩展，不是对其 Agent Runtime、桌面端或模型能力的重新实现。底座负责会话、Agent 执行与通用工具生态；本仓库新增的课程内容业务代码位于 [`business/course-content-workbench`](business/course-content-workbench)。完整的上游归属与修改声明见 [NOTICE](NOTICE)。

## 已实现的业务能力

业务层将能力的名称、说明、输入 Schema、传输方式和调用实现收敛在一张声明式登记表中；注册表负责统一发现、入参校验和调用。当前包含五类课程内容工具：

| 工具 | 用途 | 产物 / 可靠性边界 |
| --- | --- | --- |
| `clone_voice` | 调用第三方音色服务生成目标语音 | 结果引用写入任务私有目录；不是自研音色模型 |
| `parse_video` | 调用第三方转写服务后生成视频章节 | 模型输出会做形状、边界、顺序和章节完整性校验；无效时回退到确定性规则 |
| `clean_script` | 调用外部工作流清洗课程话术 | 输出写入当前任务的私有产物目录 |
| `qc_text` | 调用外部工作流返回文案问题项 | 配置缺失会显式报错，不会静默走默认地址 |
| `generate_copy` | 调用外部工作流生成课程营销文案 | 输出写入当前任务的私有产物目录 |

同一份注册表既可在宿主进程内调用，也可由 stdio MCP 服务通过 `tools/list` / `tools/call` 暴露；新增能力只需增加一条登记项，不需要改动 Agent 执行核心。

## 可靠性与隔离设计

- **章节聚合有确定性降级**：视频章节固定为开场、知识内容、营销、收尾四段。模型抛错、缺段、越界、重叠或顺序错误时，调用方仍会收到按时间均分的有序章节，而不是空结果或未处理异常。
- **任务级文件隔离**：每个任务独占 `inputs/`、`outputs/`、`tmp/` 目录；任务标识与写入路径经过白名单校验，拒绝路径穿越和跨任务覆盖。
- **冻结即时收口**：账号冻结同时使已签发凭据失效、主动关闭已建立连接、清理授权缓存并在工具执行前复核状态；撤销报告与顺序均可由测试验证。
- **与底座保持契约**：Session 上下文与 Agent 事件适配使用结构化类型，并由上游契约测试检测字段或事件枚举的静默漂移。

## 运行与验证

业务包独立维护依赖，不进入底座的 Bun workspace。需要 Node.js 22.6 或更高版本。

```bash
cd business/course-content-workbench
npm ci
npm test
```

测试覆盖能力登记、MCP `tools/list` / `tools/call`、任务目录隔离、章节回退、账号撤销和上游契约；当前为 64 个测试用例。

可将业务层以独立 stdio MCP 服务启动：

```bash
cd business/course-content-workbench
npm run serve:mcp -- --session-id demo-1 --workspace-root /absolute/path/to/workspace
```

服务会暴露五个工具。调用第三方服务前，请在运行环境中按占位变量提供端点和凭据；变量名称与示例见 [`config/capabilities.example.json`](business/course-content-workbench/config/capabilities.example.json)。

## 当前边界

- 这是可独立启动、可被 MCP 客户端接入的业务扩展包；当前没有修改 Craft 原生 UI 或将工具强行注册进其内置工具数组。
- 音色、转写和低代码工作流均为第三方服务接入，仓库不包含真实端点、密钥、项目 ID、课程素材或用户数据。
- 本仓库提供代码与测试级验证，不声称已有生产部署、业务指标或自研大模型能力。
- 课程业务目前没有独立的评测集或 Trace Benchmark；章节回退等可测试的确定性行为不等同于模型效果评测。

## 目录

```text
business/course-content-workbench/
├── src/          # 能力登记、章节聚合、任务隔离、访问撤销与事件
├── adapter/       # MCP 服务、宿主上下文与事件契约适配
├── config/        # 不含真实信息的能力配置模板
└── README.md      # 模块级设计与运行说明
```

## 许可证与上游

本仓库遵循 [Apache-2.0](LICENSE)。Craft Agents 的版权声明、许可证和本项目的修改通知均保留在 [NOTICE](NOTICE) 中。除根目录的项目说明与元数据外，业务改动集中在 `business/course-content-workbench/`；上游的 `apps/` 与 `packages/` 源代码没有因业务层接入而修改。
