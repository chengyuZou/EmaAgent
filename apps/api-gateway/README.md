# @ema-agent/api-gateway

Fastify 高并发 API 网关。

## 定位

负责：
- HTTP REST API 路由（会话、附件、设置、模型、工具、Live2D）
- WebSocket 流式事件传输
- 统一错误处理（EmaError → HTTP 状态码映射）
- 限流与 Trace ID 注入
- 静态资源服务（生产环境）

**本层禁止堆积业务逻辑**，所有业务委托给 `orchestrator-runtime`。

## 目录结构

```
src/
  server.ts              # createServer() + startServer()
  routes/
    chat.ts              # POST /api/chat + WS /api/ws/chat
    attachments.ts       # 上传/列出/删除附件
    live2d.ts            # Live2D 状态与指令
    settings.ts          # 配置读取与更新
    models.ts            # 可用模型列表
    tools.ts             # 工具列表与权限切换
    sessions.ts          # 会话 CRUD
  plugins/
    error-handler.ts     # 统一错误处理
    ws-events.ts         # WebSocket 事件推送
    rate-limit.ts        # QPS 限流
    trace.ts             # Trace ID 生成与注入
```

## 当前状态

骨架阶段。`server.ts` 入口已创建，路由与插件待实现。

## 设计决策（待实现）

1. **流式响应**：WebSocket 为主通道，SSE 为备选（某些网络环境限制 WebSocket）。
2. **错误码映射**：
   - `retryable === true` → HTTP 503（Service Unavailable）
   - `retryable === false` → HTTP 400/403/404 视错误码而定
   - 未捕获异常 → HTTP 500
3. **限流**：单会话 10 req/s，防止前端误触或循环请求。

## 依赖

- `fastify`、`@fastify/websocket`
- `@ema-agent/core-types`、`@ema-agent/constants-core`、`@ema-agent/config-kernel`、`@ema-agent/session-runtime`、`@ema-agent/llm-runtime`、`@ema-agent/tool-runtime`、`@ema-agent/orchestrator-runtime`
