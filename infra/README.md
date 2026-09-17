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
