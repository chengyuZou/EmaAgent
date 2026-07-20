# @ema-agent/context

Context 负责把持久化历史、当前输入、Prompt 与 Tool Manifest 组织成模型可见上下文。它决定哪些内容进入请求、历史媒体怎样降级以及缓存前缀在哪里结束，但不调用 Provider API，也不保存通用记忆。

```text
Session Message
    ↓ messageBuilder
Provider ModelCapabilitySnapshot
    ↓ messageCompatibility
Prompt / Tool Manifest
    ↓ promptPrefix
模型可见 Message + 稳定前缀诊断
```

当前边界：

- `messageBuilder.ts`：把 Session Message 投影为 Provider 无关的模型 Message；
- `messageCompatibility.ts`：替换当前模型无法重放的历史媒体，并拒绝本轮不受支持的输入；
- `promptPrefix.ts`：生成顺序稳定的 Tool Manifest，并计算缓存边界之前的前缀指纹；
- LLM Adapter 仍负责把 `cacheBreakpoint` 翻译成 Anthropic `cache_control` 等具体协议字段；
- Token 预算、Micro/Macro Compaction 将从 Memory 迁入 Context 的下一阶段。

所有 Context 状态必须按 Session/Turn 快照隔离，禁止使用会在多个并行 Session 之间共享可变内容的模块级缓存。
