# @ema-agent/compact

Compact 只负责在模型输入预算不足时改写 Provider 中立的历史 `Message[]`。它不组装 Context、不读取 Session、不写 SQL，也不重新获取 Memory、Narrative、Skill 或 ToolPool。

## 唯一入口

```ts
const compact = createCompact(callLlm, defaultSettings);
const result = await compact({
  sessionId,
  executionProfile,
  history,
  estimatedInputTokens,
  contextWindow,
  maxOutputTokens,
  force,
  signal,
  onEvent,
  settings,
});
```

`createCompact()` 返回一个函数。闭包只保存每个 Session 的连续失败次数，不保存 Message、Prompt 或 Session 数据，因此无需 `CompactManager`/`CompactService` 类。

请求与事件都不携带 Turn 身份：自动压缩由 Turn 把 `onEvent` 事件补 `turnId` 后投影进 Turn 事件流；手动压缩（`/compact`）由 Command 自己的出口返回结果。

## 返回值

所有分支都返回下一次 Context 装配应该使用的 `history`：

```ts
type CompactResult =
  | { kind: 'unchanged'; history: readonly Message[] }
  | { kind: 'micro'; history: readonly Message[] }
  | {
      kind: 'macro';
      history: readonly Message[];
      summary: string;
      summarizedMessageCount: number;
    };
```

- `unchanged`：未达到阈值、关闭、熔断或 Macro 失败；原历史不变；
- `micro`：只清理了确定可重取的旧 Tool Result；
- `macro`：用 `summary` 替换了输入历史中从头开始的 `summarizedMessageCount` 条。

`summary` 是预算适配后真正放进 `history` 的正文，不一定等于摘要模型的原始全文。未来持久化必须使用该字段，不能重新从 Message 字符串反向解析。

## 固定流水线

```text
阈值检查
  → Micro：清理可重取的旧 Tool Result
  → Retained Start：从尾部按 retainRatio × contextWindow 的 Token 预算选近期起点
  → Safe Cut：不拆散 tool_use / tool_result，硬预算不足时继续扩大旧前缀
  → Macro：当前模型生成结构化摘要
  → Budget：摘要 + 近期历史适配硬预算
  → 成功清零 Session 熔断；失败累计熔断
```

近期尾部由 `findRetainedHistoryStart(history, retainTokens)` 决定：`retainRatio`（5%～25%，默认 16%）是期望保留量，不是无条件保证——硬预算优先于比例。

`estimatedInputTokens` 是完整候选请求的估算。Compact 使用同一 `@ema-agent/token` 实现扣除历史外成本，但永远看不到 System Prompt、Tool definitions、Runtime Reminder 或 Current Turn 的正文。

## 摘要请求形状（KV 前缀共享）

Macro 的摘要请求与主对话共享缓存前缀：

```text
systemMessages（调用方从本轮 Context 装配结果取出，同字节、含缓存断点）
+ 结构化历史原文（不扁平化；assembleContext 在历史/当前 Turn 边界 habitual 写缓存块）
+ 尾部 user 压缩指令（恒定文本；前缀命中区之外）
```

摘要模型输入超预算时按 `findRetainedHistoryStart` 从尾部 Token 累计收缩（不做砍半或字符串掐头去尾），被丢弃的最旧部分在指令里如实标注条数；Provider 仍判超时按 ×0.8 缩预算重试至多 3 次。

## Macro 持久化接线

本包不持有 Storage 端口；调用方经 `CompactRequest.saveMacroSummary(summary, summarizedMessageCount)` 闭包落库（根 Turn / `/compact` Command 提供，子 Agent 不提供）：

1. 闭包内用 `LlmHistoryMessage[summarizedMessageCount - 1]` 把计数映射成 `summarizedThroughMessageId`；
2. 经 `SessionStore.appendHistorySummary()` 写入 `kind='summary'` 的 Message 与覆盖截止游标；
3. **保存成功才发 `compact_completed`**；闭包抛错则发 `compact_failed` 并原样上抛，调用方继续使用原历史。

`messages.summarized_through_message_id` 是 Summary 的覆盖截止游标；`loadHistory()` 按游标消息位置切边界，摘要不以自身插入时间吞掉生成期间写入的 reminder/用户消息。

## 保护范围

Micro 只清理旧的成功 `Read/Glob/Grep/WebFetch/WebSearch` 结果并保留最近 N 条。Shell、写入、AskUser、Skill、MCP 和错误结果不可确定性清理，只能由 Macro 摘要。

单个 Tool Result 的字节上限、预览、外置文件和清理由 Tools Results 负责，不属于 Compact。
