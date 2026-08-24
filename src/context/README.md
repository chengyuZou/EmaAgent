# @ema-agent/context

Context 只负责把已经准备好的事实组装成一次 LLM Call 的 Provider 中立输入。它不读取数据库、不查询 Memory/Narrative、不生成或插入 reminder、不调用模型，也不决定是否压缩。

## 唯一入口

```ts
const prepared = assembleContext({
  systemPrompt,
  toolPool,
  history,
  currentTurn,
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
Current Turn（首条是本 Turn 持久化 reminder 的回放；最后一条有效消息带 cacheBreakpoint）

tools = 当前 ToolPool 的原顺序投影
```

Prompt 的动态边界哨兵只用于定位稳定缓存切口，发送前必须移除。Context 不重新排序 ToolPool，也不保存 Prompt revision、Manifest 或 Snapshot。

## Reminder 不在本包

Turn reminder 表示"本 Turn 开始时的事实"：它在根 Turn 开始时由 Turn 生成一次并作为 `kind='reminder'` 的 Session Message 持久化，随后经有序 History 进入本包。本包只组装，不知道哪条是 reminder；Usage 分类把它计入 `messages`。

## Session Message 投影

`deriveLlmHistory()` 是持久化 Session Message 到 LLM Message 的唯一转换入口。它异步返回 `LlmHistoryMessage[]`（`sessionMessageId + message`），因为附件解析可能读取文件或等待 Vision：

- 丢弃旧 system；
- thinking 作为协议原生推理状态保留，并为每条 Assistant 历史 attach 所属 Turn 的生成来源 `generatedBy`（providerId + modelId + protocol）；重放/删除由目标协议 Adapter 依据 `generatedBy` 与本次调用目标裁决，本包不判断协议兼容性；
- 只保留完整配对的 `tool_use/tool_result`；
- 中断的 Assistant Message 不进入模型历史；
- 附件引用交给 Turn 注入的 `ResolveHistoryAttachment` 解析；Context 不读取 AttachmentStore，也不调用 Vision；
- 历史 Skill 引用变成调用 Skill Tool 的明确指引，SKILL.md 正文不进入 Session Message。

`generatedBy` 只对模型生成的 Assistant 历史有意义；user/tool_result/reminder/summary 不伪造。Adapter 编码厂商 Wire 消息时消费并剥除，绝不序列化进请求。

投影会丢消息（空块、未配对 Tool 块），产出比输入短；`sessionMessageId` 只用于 Macro 摘要成功后映射 `summarizedThroughMessageId`，不进入 Compact 或 LLM 请求，也不允许按下标对齐输入。

## 与 Compact 的关系

Context 与 Compact 互不导入。TurnExecution 的接线顺序是：

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
- Reminder 的生成与持久化：Turn；
- `attachment_ref` 的图片/文本投影与 Vision 描述缓存：Attachments，由 Turn 注入解析函数；
- Tool Result 截断、落盘和清理：Tools Results；
- Provider 协议与 `cache_control`：LLM Adapter；
- `context_usage_updated` 事件身份与发射：TurnExecution/Turn；
- Turn 累计 Usage：TurnExecution。
