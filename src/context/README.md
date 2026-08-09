# @ema-agent/context

Context 只负责把已经准备好的事实组装成一次 LLM Call 的 Provider 中立输入。它不读取数据库、不查询 Memory/Narrative、不调用模型，也不决定是否压缩。

## 唯一入口

```ts
const prepared = assembleContext({
  executionProfile,
  systemPrompt,
  toolPool,
  history,
  currentTurn,
  reminder,
  contextWindow,
});
```

`assembleContext()` 是同步纯函数。同一份输入必然得到同一份结果，TurnExecution 可以在 Compact 前后安全地各调用一次。

`PreparedContext` 只有三项：

- `messages`：真正交给 LLM 的中立消息；
- `tools`：从当前根 Turn 的同一个 `ToolPool` 投影出的 `LlmToolDef[]`；
- `usage`：这份最终请求的分类 Token 估算。

它不返回 `history` 或 Compact 结果。调用方原本就持有历史，Context 不制造第二份状态。

## 固定顺序

```text
System Prompt 稳定段（尾部 cacheBreakpoint）
System Prompt 动态段
History
<system-reminder> 当前调用运行时事实
Current Turn（最后一条有效消息带 cacheBreakpoint）

tools = 当前 ToolPool 的原顺序投影
```

Prompt 的动态边界哨兵只用于定位稳定缓存切口，发送前必须移除。Context 不重新排序 ToolPool，也不保存 Prompt revision、Manifest 或 Snapshot。

## system-reminder

`ContextReminder` 是固定输入，不是可注册的插槽。空字段省略，顺序如下：

1. 当前日期；
2. Git 摘要（只在 Work 模式且可读取时）；
3. Memory Recall；
4. Narrative Recall；
5. Task 提醒；
6. Scratchpad；
7. 子 Agent Mailbox。

这些事实由各自业务所有者生成，Context 只负责序列化。Git 命令仍归 `@ema-agent/git`，Memory/Narrative 查询也不进入本包。

## Session Message 投影

`buildMessages()` 是持久化 Session Message 到 LLM Message 的投影函数：

- 丢弃旧 system 和 `narrative_context`；
- thinking 只供 UI/审计，不跨 Provider 重放；
- 只保留完整配对的 `tool_use/tool_result`；
- 历史附件引用变成明确占位，真实媒体兼容由 LLM Request Preparer 处理。

## 与 Compact 的关系

Context 与 Compact 互不导入。未来的 TurnExecution 接线顺序是：

```text
candidate = assembleContext(originalHistory)
compactResult = compact(candidate.usage.estimatedInputTokens, originalHistory)

unchanged → candidate 直接发送
micro     → assembleContext(compactResult.history) 后发送
macro     → 先持久化摘要，再 assembleContext(compactResult.history) 后发送
```

压缩前的候选只用于预算判断；对外 Context Usage 必须来自真正发送给 Provider 的最终装配结果。

## 不属于 Context

- 压缩阈值、摘要和熔断：Compact；
- Summary SQL 持久化：TurnExecution + Session/Storage；
- 历史媒体兼容：LLM Request Preparer；
- Tool Result 截断、落盘和清理：Tools Results；
- Provider 协议与 `cache_control`：LLM Adapter；
- `context_usage_updated` 事件身份与发射：TurnExecution/Turn；
- Turn 累计 Usage：TurnExecution。
