# @ema-agent/compact

`compact` 只负责在模型输入预算不足时改写可压缩历史。它不组装 Context、不读取 Memory/Narrative/Skill、不投影 ToolPool，也不写 Session。

唯一入口是 `CompactMessages.compact(request)`：调用方提交可改写历史、完整候选请求的最新 Token 估算和模型窗口；返回新的历史与诊断。Macro 成功时额外返回 `summary`，由 TurnExecution 决定是否持久化。

```ts
const compact = new CompactMessages(languageModel, defaultSettings);
const result = await compact.compact({
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

`estimatedInputTokens` 是 Context 对完整候选请求的最新估算，不是单独的历史估算。Compact 用同一 `@ema-agent/token` 实现计算历史改写前后的差值，使最近一次真实 Provider Usage 仍可作为总量锚点。

执行顺序固定：

```text
阈值检查
  → Micro：清理可重取的旧 Tool Result
  → Safe Cut：不拆散 tool_use / tool_result
  → Macro：当前模型生成结构化摘要
  → Budget：摘要 + 近期历史适配硬预算
  → 成功清零 Session 熔断；失败累计熔断
```

System Prompt、当前 Turn、Memory/Narrative Recall 与激活 Skill 等受保护内容不得出现在 `history`；它们只通过完整请求估算影响预算，Compact 不提供第二条恢复消息注入通路。单个 Tool Result 的外置、截断与清理由 Tools Results 负责，不属于本包。

结果语义：

- `not_needed`：历史原样返回；
- `completed + method: micro`：只提交确定性的旧只读 Tool Result 清理；
- `completed + method: macro`：提交摘要与安全保留的近期历史；
- `failed/skipped`：历史原样返回，绝不泄漏中间 Micro 结果；
- 取消发送 `compact_cancelled` 后直接抛给当前 Turn，不计入失败熔断。

`force` 只表示 Provider 已报告输入超限的响应式恢复。它绕过自动压缩开关、阈值和自动失败熔断，但仍然只允许上层在同一逻辑调用中触发一次。

Micro 只清理旧的成功 `Read/Glob/Grep/WebFetch/WebSearch` 结果，并保留最近 N 条。Shell、写入、AskUser、Skill、MCP 和错误结果都不可被确定性清理；它们只能由 Macro 摘要。这个集合依据 LLM Message 中实际保存的 Tool 名称判断，不接管 Tool 注册或 Tool Result 文件。
