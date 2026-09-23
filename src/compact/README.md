# @ema-agent/compact

Compact 在模型输入接近窗口上限时, 把模型可见的工作消息 `Message[]` 整理成更短的 `Message[]`. 它只改写消息内容, 不读取 Session 或 SQL, 也不负责组装完整 LLM 请求. System Prompt 由调用方单独传入, 不放在待压缩的 `messages` 中.

## 公共入口

```ts
const compact = createCompact(callLlm, defaultSettings);
const result = await compact({
  sessionId,
  sessionMode,
  messages,
  systemMessages,
  tools,
  estimatedInputTokens,
  contextWindow,
  thinking,
  modelMaxOutput,
  signal,
  emit,
  saveMacroSummary,
});
```

`createCompact()` 返回压缩函数. `defaultSettings` 可以覆盖默认设置; 单次请求也可以用 `settings` 指定完整设置. 函数只按 `sessionId` 记录连续失败次数, 不缓存消息或 Prompt.

输入中几个容易混淆的量:

- `messages`: 按模型可见顺序排列的工作消息, 不含 System Prompt. 这是 Compact 唯一可改写的消息数组.
- `systemMessages`, `tools`, `thinking`: 摘要请求复用的模型配置. 它们用于摘要调用, 不是待压缩历史.
- `estimatedInputTokens`: 调用方对完整候选请求的估算, 包括 `messages` 之外的固定成本. Compact 用差额计算替换消息后完整请求的估算量.
- `force`: 跳过自动触发阈值和连续失败熔断, 但仍受摘要请求和最终请求的预算限制.
- `micro`: 默认执行 Micro; 传 `false` 则只走 Macro. 手动 `/compact` 不落盘 Micro 的替换, 因而传 `false`.
- `saveMacroSummary`: 可选的持久化回调, 接收最终摘要正文和 `summarizedMessageCount`. Compact 不知道 SQL Message ID; 调用方负责把计数映射为覆盖截止位置.

## 返回值和事件

三个结果分支都带有后续应使用的 `messages`:

- `unchanged`: 未触发, 被熔断, 或 Macro 失败. Macro 失败时仍返回原输入消息, 并带 `failureDetail`; 不会交付只压缩了一半的数组.
- `micro`: 只替换了可重新获取的旧 Tool Result 内容. 消息数量和顺序不变.
- `macro`: 第一条消息是 `<context-summary>` 包裹的摘要, 后面是保留原文的近期消息. 附带 `beforeTokens`, `afterTokens`, `savedTokens`, `durationMs`, 摘要调用的 `usage` 总和, 以及 `summarizedMessageCount`.

`summarizedMessageCount` 表示输入 `messages` 从头起有多少条被最终摘要覆盖. 若前缀中已有一条旧摘要, 它也算一条输入消息. 该值不是 SQL 自增 ID, 也不是被直接丢弃的消息数.

Macro 发 `compact_started` 后, 最终只会走 `compact_completed`, `compact_failed` 或 `compact_cancelled`. Micro 不发这些事件. 最终摘要全部生成并通过预算检查后, 才调用 `saveMacroSummary`; 保存成功才发 `compact_completed`. 保存回调抛错时发 `compact_failed` 并上抛. 取消则发 `compact_cancelled` 并上抛.

## 压缩过程

默认在完整请求估算超过 `contextWindow * (1 - bufferRatio)` 时触发. 先运行 Micro; 如果它使请求回到预算内, 就返回 `micro`. 否则进入 Macro.

Micro 只清理较旧且成功的 `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` 结果, 并保留最近 `keepRecentToolResults` 条可清理结果. 错误结果以及无法确定可重新获取的工具结果保持原文.

Macro 的消息边界是一个切点: 切点左边的消息全部参加摘要, 右边的消息保留原文. `retainRatio` 决定初始近期保留量; 如果原文尾部和摘要放不进最终请求, 切点向右移动, 让更多消息参加摘要. 切点不会把一个 `tool_use` 和对应的 `tool_result` 分到两侧.

切点计算只估算一次每条消息的 token, 再组成后缀数组. 例如三条消息分别为 `10, 20, 40` Token, 后缀数组就是 `[70, 60, 40, 0]`. 近期原文预算为 `45` 时, 二分找到从第 2 条消息开始的 `40` Token 尾部; 从第 1 条开始则是 `60` Token, 放不下. 摘要分段用同一数组二分寻找预算内最远的结束切点, 然后避开会拆开工具调用与结果的位置.

待摘要前缀若一次放不进摘要请求, 就按时间顺序分段. 每段输入为 `systemMessages + 上一段摘要 + 当前完整消息段 + 压缩指令`, 并复用传入的工具定义和 thinking 配置. 成功后游标才前进; Provider 报输入过长或模型以 `max_tokens` 结束时, 缩小当前分段重试, 后移的消息留给下一段. 每段至多尝试 3 次.

例如输入为 `A B C D`, 切点在 `C` 前, 最终得到 `Summary(A+B) C D`. 若 `A B` 还需分段, 第二段会看到第一段摘要和后续原文, 不会跳过早期消息. Macro 不预先截断旧前缀, 也不裁剪已经生成的摘要正文. 任何分段失败或最终摘要无法与近期原文一起放进预算, 都返回原输入消息.

摘要请求使用调用方提供的 System Prompt 和 Tool 定义, 以保持与主请求一致的前缀. 压缩指令要求模型只输出摘要而不调用工具; 如果它实际返回 `tool_use`, 本次 Macro 失败.

## 职责边界

Compact 不组装 Context, 不决定 SQL 摘要的覆盖游标, 不持久化 Micro 替换, 也不处理 Tool Result 的外置文件或字节上限. `saveMacroSummary` 是调用方提供的保存动作; 子代理等不需要落库的调用方可以不提供. 包的公开类型和设置从 `index.ts` 导出.
