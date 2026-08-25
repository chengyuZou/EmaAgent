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
  force,
  micro,   // 缺省 true；手动 /compact 传 false（只要纯 Macro 摘要）
  signal,
  emit,
  settings,
});
```

`createCompact()` 返回一个函数。闭包只保存每个 Session 的连续失败次数，不保存 Message、Prompt 或 Session 数据，因此无需 `CompactManager`/`CompactService` 类。

请求与事件都不携带 Turn 身份：自动压缩由 Turn 把 `emit` 事件补 `turnId` 后投影进 Turn 事件流；手动压缩（`/compact`）由 Command 自己的出口返回结果。

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
阈值检查（触发线 = 窗口 × (1 - bufferRatio)，默认 85%）
  → Micro（请求级开关，缺省开；手动 /compact 传 micro:false 关闭——替换不落库，
    命令路径只要纯 Macro）：清理可重取的旧 Tool Result
  → Macro（macroCompact 内部全包，切割不离开该文件）：
      单趟双边界切割：85% 触发线一刀切（窗口截断，丢弃事实随结果返回）
      + 16%（retainRatio）近期原文保留选取，配对安全一趟调整
      → 硬预算扩张：保留线右移直到 tail + 摘要最小预算可拟合（单条超大消息也进 Macro）
      → 候选按摘要模型输入预算收缩，Provider 判超按比例重试（≤3 次）
      → 摘要 + 保留尾预算拟合（二分裁剪摘要正文）
  → 成功清零 Session 熔断；失败累计熔断
```

近期保留是期望保留量不是无条件保证——硬预算优先于比例（扩张与拟合兜底）。窗口截断只有随成功的压缩生效才是事实：`compact_history_truncated` 在 Macro 成功后补发，丢弃偏移计入 `summarizedMessageCount`（相对输入历史），调用方游标映射无需感知偏移。

`estimatedInputTokens` 是调用方在调用时刻对完整候选请求的本地最佳估算，不得小于 history 本身（`validateRequest` 校验；历史外成本不能为负）。Compact 不重新获取 System Prompt、Tool definitions、Runtime Reminder 或 Current Turn——它们由调用方以 `systemMessages`/`tools` 显式传入（摘要请求与主对话共享 KV 前缀就靠这个），历史区间是唯一允许 Compact 改写的内容。

## 摘要请求形状（KV 前缀共享）

Macro 的摘要请求与主对话共享缓存前缀：

```text
systemMessages（调用方从本轮 Context 装配结果取出，同字节、含缓存断点）
+ 结构化历史原文（不扁平化；assembleContext 在历史/当前 Turn 边界 habitual 写缓存块）
+ 尾部 user 压缩指令（恒定文本；前缀命中区之外）
```

摘要模型输入超预算时按后缀 Token 累计从尾部收缩候选（不做砍半或字符串掐头去尾），被淘汰的最旧部分在指令里如实标注条数并计入 `droppedMessageCount/droppedTokens`；Provider 仍判超时按 ×0.8 缩预算重试至多 3 次。

## Macro 持久化接线

本包不持有 Storage 端口；调用方经 `CompactRequest.saveMacroSummary(summary, summarizedMessageCount)` 闭包落库（根 Turn / `/compact` Command 提供，子 Agent 不提供）：

1. 闭包内用 `LlmHistoryMessage[summarizedMessageCount - 1]` 把计数映射成 `summarizedThroughMessageId`；
2. 经 `SessionStore.appendHistorySummary()` 写入 `kind='summary'` 的 Message 与覆盖截止游标；
3. **保存成功才发 `compact_completed`**；闭包抛错则发 `compact_failed` 并原样上抛，调用方继续使用原历史。

`messages.summarized_through_message_id` 是 Summary 的覆盖截止游标；`loadHistory()` 按游标消息位置切边界，摘要不以自身插入时间吞掉生成期间写入的 reminder/用户消息。

## 保护范围

Micro 只清理旧的成功 `Read/Glob/Grep/WebFetch/WebSearch` 结果并保留最近 N 条。Shell、写入、AskUser、Skill、MCP 和错误结果不可确定性清理，只能由 Macro 摘要。

单个 Tool Result 的字节上限、预览、外置文件和清理由 Tools Results 负责，不属于 Compact。
