# 企业基础设施

本目录提供本机/测试服务器的 PostgreSQL、Redis 和 MinIO 组合。生产环境可以替换为云厂商的托管 PostgreSQL、Redis 和 OSS/S3；不要求三个服务与 Craft Server 部署在同一台机器。

```powershell
Copy-Item infra/.env.enterprise.example infra/.env.enterprise
# 修改密码、Bucket 和 Craft Secret 后启动
docker compose --env-file infra/.env.enterprise -f infra/docker-compose.enterprise.yml up -d
docker compose --env-file infra/.env.enterprise -f infra/docker-compose.enterprise.yml ps
```

服务用途：

- PostgreSQL：账号、部门、Agent、任务、文件元数据和用量事件；
- Redis：异步任务队列、重试、限流、分布式锁；
- MinIO：S3 兼容的输入视频、音频和 Agent 输出文件。

当前代码仍保留单机 JSON/本地文件后端作为默认值；切换企业后端时使用同一组领域接口迁移目录、用量和任务数据，不把密钥明文写入 PostgreSQL。

当前可用的企业适配：

- 设置 `AGENT_WORKBENCH_DATABASE_URL` 后，团队账号、部门、Agent Manifest、用量和 Case Memory 使用 PostgreSQL；
- 设置 `S3_BUCKET`、`S3_ACCESS_KEY`、`S3_SECRET_KEY` 后，任务文件使用 S3/OSS/MinIO。浏览器会优先请求预签名上传地址，大文件不再经过 Craft Server；
- `AGENT_WORKBENCH_REDIS_URL` 提供 Redis Streams 队列连接；再设置 `AGENT_WORKBENCH_ASYNC_TASKS=true` 和 `AGENT_WORKBENCH_START_WORKER=true` 后，调用会排队并由 Worker 执行。队列实现位于 `business/agent-workbench/src/task-queue.ts`，Worker 也可以独立于 Craft Server 运行；
- 未设置这些连接时仍使用本地 JSON/文件实现，适合开发预览。

不要把 `.env.enterprise` 提交到 Git；它已经被 `.gitignore` 忽略。云 OSS 若使用 HTTPS，建议关闭 `S3_FORCE_PATH_STYLE`，MinIO 则保持为 `true`。
