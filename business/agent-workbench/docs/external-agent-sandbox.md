# 外部 Agent 沙箱联调（Dify）

`Dify` 已由运行时以 `dify-workflow` 协议适配；这份流程用于把“可配置示例”升级为某个部署环境的**可复现验证记录**。它是显式操作：普通测试与 GitHub Actions 不会请求第三方，也不会使用仓库密钥。

## 前置条件

在你拥有的 Dify 沙箱中准备一个 Workflow，并确认其开始节点需要的输入字段。创建只具备该沙箱最小权限的 API Key；不要使用个人主 Key，也不要把任何值写入 Manifest、`.env` 或 Git。

## 运行

PowerShell 示例（变量只保留在当前 shell）：

```powershell
$env:DIFY_BASE_URL = 'https://your-dify-sandbox.example'
$env:DIFY_API_KEY = '<sandbox-api-key>'
$env:DIFY_SANDBOX_INPUT = '{"topic":"connectivity check"}' # 改成 Workflow 实际要求的输入
cd business/agent-workbench
npm run verify:dify-sandbox -- --out artifacts/dify-sandbox-check.json
```

脚本会走与生产工作台相同的 Manifest Runtime，向 `/v1/workflows/run` 发送 `blocking` 工作流请求。成功时只输出并写入以下脱敏元数据：耗时、输入 SHA-256 指纹、返回字节数、顶层字段名。失败时也只写入失败类别；不会保存请求正文、响应正文、URL 或 Key。

运行完成后，先人工查看 `artifacts/dify-sandbox-check.json`，再将其中不含敏感信息的文件作为部署验收附件保存到公司制品库。`artifacts/` 已被 Git 忽略。

## 验收标准

- 文件中的 `status` 为 `success`；
- Agent 标识为 `dify-sandbox`，且耗时、指纹和返回大小均存在；
- 重新运行时可得到新的时间/耗时，但不会出现 API Key、端点、业务输入或完整输出；
- 若 Workflow 改了输入字段，脚本应以非零退出并留下 `upstream-or-workflow-error`，而不是静默通过。

Coze 可按同一模式另建一个部署自有的脚本：将 Manifest 的 `payloadMode` 改为 `coze-workflow`，并按 Coze 的实际调用协议配置路径和输入。仓库不会把任一第三方服务宣称为“已验证”，除非该环境按此流程产生了对应验收制品。
