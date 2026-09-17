# 企业部署清单

## 本地预览

```powershell
$env:CRAFT_TEAM_MODE = 'true'
$env:AGENT_WORKBENCH_MASTER_KEY = '<base64 编码的 32 字节随机值>'
# 管理员初始账号只通过环境变量注入
$env:CRAFT_TEAM_ADMIN_USERNAME = 'admin'
$env:CRAFT_TEAM_ADMIN_PASSWORD = '<至少 10 位随机密码>'
```

启动 Server 和 WebUI 后，管理员在「AI 工作台 → 管理设置」配置公司聊天模型、Dify/Fish/HTTP/Python/MCP Agent 的地址和 Key。员工只使用管理员发布的 Agent，不会看到模型供应商、API Key 或 Secret 值。

## 基础设施准备

本机或测试服务器可以先启动仓库提供的 PostgreSQL、Redis 和 MinIO 组合：

```powershell
Copy-Item infra/.env.enterprise.example infra/.env.enterprise
# 修改密码和密钥后执行
docker compose --env-file infra/.env.enterprise -f infra/docker-compose.enterprise.yml up -d
```

生产环境不要求这些服务和 Craft Server 在同一台机器上。优先使用托管 PostgreSQL、Redis 和 OSS/S3；公司内网部署可用 MinIO。数据库初始化脚本位于 `infra/postgres/001_init.sql`。PostgreSQL 只保存业务元数据，不保存明文 Key；视频、音频和其他大文件放到对象存储。

## 上线前必须完成

1. 使用 HTTPS/WSS 反向代理；Cookie 的 Secure 属性保持开启。
2. 将 `AGENT_WORKBENCH_MASTER_KEY` 放入 Secret Manager，不写入镜像、仓库或日志。
3. 单实例演示可以使用 JSON 文件；多实例必须把团队目录、加密凭证库、用量账本和幂等记录迁移到 PostgreSQL/Redis 等共享存储，并配置备份与恢复演练。
4. 只给管理员开放 `/api/workbench/config`、`/api/workbench/secrets`、账号管理和用量团队接口。服务端已经做角色校验，前端隐藏不是安全边界。
5. 为每个 Agent 先点击「测试连接」，再启用发布；测试调用默认标记为 `admin_test`，不会混入业务用量统计。
6. 大文件通过独立上传接口进入当前员工 Workspace 的任务 `inputs/`；不要把视频作为普通 JSON 请求发送。生产环境应将 `LocalTaskArtifactStore` 替换为 OSS/S3/MinIO 实现，并使用预签名上传 URL，避免 Craft Server 进程承载大文件内存。
7. 使用 Redis 队列和独立 Worker 执行视频解析、音频生成等长任务；浏览器只轮询任务状态或接收 SSE/WebSocket 进度。

## 凭证模式

- `managed`：Key 由管理员保存到服务端加密库，运行时按引用注入；适合 Dify、Fish 和公司统一网关。
- `external`：Agent 自己处理认证，工作台不保存或注入 Token；只适合已经在受控网络中完成认证的服务。
- `none`：服务完全不需要认证。Manifest 的静态 Body 禁止出现 `api_key`、`password`、`authorization` 等疑似密钥字段。

默认业务用量按成员、部门、Agent 汇总，日期筛选通过 `/api/workbench/usage/team?from=YYYY-MM-DD&to=YYYY-MM-DD` 完成。管理员测试审计可显式追加 `includeTests=true`。
