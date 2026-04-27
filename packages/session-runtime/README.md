# @ema-agent/session-runtime

## 一句话职责

会话生命周期管理：创建、加载、保存、消息追加、上下文窗口构建、压缩触发。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— ChatMessage、SessionState、RollingSummary
- `@ema-agent/constants-core` —— 会话相关常量
- `@ema-agent/storage-sql` —— SessionRepo 接口（持久化读写）

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— 调用 SessionService
- `@ema-agent/memory-runtime` —— 读取会话历史（L2）
- `@ema-agent/api-gateway` —— 会话 CRUD 接口

## 对外接口

- `export interface SessionService` —— 会话服务接口
- `export function buildContextWindow()` —— 构建 LLM 上下文窗口
- `export function triggerCompaction()` —— 触发滚动摘要压缩

## 禁止事项

- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止 import `memory-runtime`（memory 可以读 session，但 session 不应依赖 memory）
- ❌ 禁止直接操作 SQL（必须通过 storage-sql 的 repo 接口）
- ❌ 禁止在会话模型里写 LLM 调用逻辑
