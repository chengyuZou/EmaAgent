# @ema-agent/memory-runtime

## 一句话职责

四层记忆的统一召回服务：L1 工作记忆、L2 会话历史、L3 身份档案、L4 用户画像与世界知识。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— ContextBlock、RecallRequest、RecallResult、RollingSummary
- `@ema-agent/constants-core` —— 记忆相关常量
- `@ema-agent/storage-sql` —— UserProfileRepo（读写 L4）
- `@ema-agent/session-runtime` —— SessionService（读取 L2）

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— 组装 prompt 前调用 recall()

## 对外接口

- `export interface MemoryRuntime` —— 记忆服务统一接口
- `export function recall()` —— 按 mode 执行召回
- `export function extractToProfile()` —— Agent reflect 沉淀到 L4
- `export function compact()` —— 触发会话压缩

## 禁止事项

- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止直接操作文件系统（走 storage-sql）
- ❌ 禁止修改原始 user query（召回结果只注入 system prompt）
- ❌ 禁止在 memory-runtime 里写 LLM 调用（压缩/反思应由 orchestrator 触发）
