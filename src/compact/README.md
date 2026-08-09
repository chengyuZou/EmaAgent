# @ema-agent/compact

Compact 只负责在模型输入预算不足时改写 Provider 中立的历史 `Message[]`。它不组装 Context、不读取 Session、不写 SQL，也不重新获取 Memory、Narrative、Skill 或 ToolPool。

## 唯一入口

```ts
const compact = createCompact(languageModel, defaultSettings);
const result = await compact({
  sessionId,
  turnId,
  executionProfile,
  history,
  estimatedInputTokens,
  contextWindow,
  maxOutputTokens,
  providerId,
  model,
  force,
  signal,
  emit,
  settings,
});
```

`createCompact()` 返回一个函数。闭包只保存每个 Session 的连续失败次数，不保存 Message、Prompt 或 Session 数据，因此无需 `CompactManager`/`CompactService` 类。

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
      compactedMessageCount: number;
    };
```

- `unchanged`：未达到阈值、关闭、熔断或 Macro 失败；原历史不变；
- `micro`：只清理了确定可重取的旧 Tool Result；
- `macro`：用 `summary` 替换了前 `compactedMessageCount` 条模型历史。

`summary` 是预算适配后真正放进 `history` 的正文，不一定等于摘要模型的原始全文。未来持久化必须使用该字段，不能重新从 Message 字符串反向解析。

## 固定流水线

```text
阈值检查
  → Micro：清理可重取的旧 Tool Result
  → Safe Cut：不拆散 tool_use / tool_result
  → Macro：当前模型生成结构化摘要
  → Budget：摘要 + 近期历史适配硬预算
  → 成功清零 Session 熔断；失败累计熔断
```

`estimatedInputTokens` 是完整候选请求的估算。Compact 使用同一 `@ema-agent/token` 实现扣除历史外成本，但永远看不到 System Prompt、Tool definitions、Runtime Reminder 或 Current Turn 的正文。

## Macro 持久化接线

本包只返回持久化事实，不持有 Storage 端口。未来 TurnExecution 在 `kind === 'macro'` 时负责：

1. 把 `compactedMessageCount` 映射到原始 Session Message 的稳定截止游标；
2. 在单个 SQL 事务中写入 `kind='summary'` 的 Message 和截止游标；
3. 保证当前 Turn 的用户 Query 与截止点之后的消息不被 Summary 查询吞掉；
4. SQL 成功后才采用 `result.history` 继续本轮；失败则继续使用原历史。

当前 `messages` 表以 Summary 插入时间作为边界，无法严谨表达“Summary 创建于当前 Turn，但只覆盖更早历史”。接线批必须为 Summary 增加明确的覆盖截止游标，或建立等价的稳定顺序语义；不能只依赖 `created_at`。最近用户 Query 可以按 `sessionId + role='user'` 一次 SQL 读取，但它是恢复保护，不替代 Summary 截止游标。

## 保护范围

Micro 只清理旧的成功 `Read/Glob/Grep/WebFetch/WebSearch` 结果并保留最近 N 条。Shell、写入、AskUser、Skill、MCP 和错误结果不可确定性清理，只能由 Macro 摘要。

单个 Tool Result 的字节上限、预览、外置文件和清理由 Tools Results 负责，不属于 Compact。
