# Lengshan / 企业微信接入边界

Lengshan 负责企业微信的收发、租户隔离和媒体中转；AI 工作台负责 Agent 编排、凭证、权限和用量。两边不要共享模型 Key，也不要让员工浏览器直接请求企业微信。

## 推荐链路

```text
企业微信 ⇄ Lengshan ⇄（签名 Webhook）⇄ Craft Server / AI 工作台 ⇄ Agent
```

工作台提供了一个不绑定厂商字段的适配边界：`business/agent-workbench/adapter/lengshan-webhook.ts`。部署时把 Lengshan 的字段映射到以下标准事件：

```json
{
  "eventId": "evt-2026-0001",
  "tenantId": "tenant-a",
  "userId": "wecom-user-a",
  "departmentId": "sales",
  "conversationId": "conversation-a",
  "text": "客户想了解课程",
  "attachments": [{ "type": "image", "url": "https://lengshan.example/media/x.jpg" }]
}
```

回复时使用 `eventId` 做幂等键，并把 Agent 的文本、文件链接和业务标签映射回 Lengshan 的发送接口。Webhook 应带 HMAC-SHA256 签名；生产环境的 `EventDeduper` 应替换为 Redis/PostgreSQL，避免多实例重复消费。

本仓库没有凭空假设 Lengshan 的真实 URL、签名头和字段名。拿到 Lengshan 的接口文档后，只需在边界适配器中补充字段映射和发送客户端，不需要修改 Agent Runtime 或凭证模型。
