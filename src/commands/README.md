# @ema-agent/commands

Command 是用户显式触发的确定性产品操作. V1 只有一个真实行为: `/compact` 直接改写 Session 历史, 不创建 Turn.

本包不做：

- 文本 `/` 解析：服务端不解析命令语法；本地命令只在输入框草稿是开头的 `/搜索词` 且没有引用胶囊时出现在菜单里, 用户选中后立即执行。手敲 `/compact` 再发送仍是普通文字；Skill 可以从正文中的 `/` 搜索并选入引用胶囊；
- Skill 解析：Skill 是 `TurnInputPart` 结构化输入块，目录归 skills 包（`/api/skills`），消费归 turn 包（prepareTurn → `skill_ref` → SkillTool 读正文）；
- 模型切换：Session PATCH 保存顶层 `providerId`、`modelId` 和 `reasoningEffort`, 普通 Turn 从 Session 读取, 不需要后端命令或消息里的模型覆盖字段。

## 公共入口

```ts
compactSession(deps, sessionId): Promise<ManualCompactResult>
listCommandDescriptors(): readonly CommandDescriptor[]
```

目录投影只含确定性命令自身字段（name/description）；前端菜单把它与 `/api/skills` 的 Skill 目录合并展示，本包不复制 Skill 任何字段。

## 手动压缩流程

```text
生成 compactId
→ SessionRunningRegistry.register(sessionId, { kind: 'compact', compactId })   // Session 已忙碌则抛 SessionBusyError
→ loadHistory → projectMessages（模型来源与对话角色共用 createTurnHistoryResolver）
→ 手动下限闸：历史估算 < 窗口 × settings.manualMinRatio（默认 15%）拒绝 compact_below_threshold
  ——只量可压缩历史本身；高于它用户随时可主动整理，不等 85% 自动触发线
→ staticSystemPrompt + getDynamicSystemPrompt (与下一 Turn 使用同样的装配规则) → buildPromptMessages → systemMessages
→ compact(force=true + micro=false，终态必是 macro；tools=[]、推理强度沿用 Session)
→ saveMacroSummary：summarizedMessageCount → historyWithIds 游标映射 → appendHistorySummary
→ ManualCompactResult { beforeTokens, afterTokens, savedTokens, durationMs }
finally 清除 Session 运行占用, 再调用 onFinished
```

- 同一 Session 不同时执行 Turn 与手动压缩. 两者使用同一运行记录, 冲突时抛出 `SessionBusyError`.
- 停止必须带真实身份: Desktop 对 Turn 发送 `cancel_turn { turnId }`, 对手动压缩发送
  `cancel_compact { compactId }`. Registry 只取消身份仍匹配的工作, 迟到的按钮不会停掉同一
  Session 后来开始的工作. 自动压缩在 Turn 内部运行, 与 Turn 共用取消信号, 不另建运行记录.
- 手动压缩期间输入框仍可编辑和发送, 输入由 SessionContinuationQueue 排队. `onFinished` 在清除占用后交付 completed, cancelled 或 failed. Server 装配层将 completed 交给队列继续执行; cancelled 和 failed 则退回未保存输入, 不自动启动 Turn. 登记运行占用之前的请求拒绝不触发此回调, 不影响已经运行的工作.
- 模型解析与下一 Turn 同规则: `Session.providerId/modelId`, 未配置即 `provider/not_configured`; 下一 Turn 读取压缩后的历史.
- 手动压缩使用所属 Turn 保存的角色名字, 给有正文的普通 Assistant 消息标明发言人, 包括当前角色. 每次操作建立一份临时 Map, 与模型来源共用查询结果; 不为压缩创建 Turn, 不查角色是否仍存在或有没有参考音频. 摘要按事实保留必要的发言归属, 不改写原消息.
- 摘要请求由 systemMessages, 结构化历史与尾部摘要指令组成. `tools` 恒空, 因为 Turn 的 ToolPool 中的子代理, scratchpad 与 Narrative 需要真实 Turn 身份, 手动压缩不能伪造 Turn. 它与 Turn 使用相同的静态产品规则, 工作区, Memory, Skill, MCP, 当前角色与权限说明; 能力指引因工具集合不同而不同, 不宣称与 Turn 共享历史边界的缓存断点. 手动路径直接读取 Session 的模型和推理强度.
- `micro:false`：Micro 的占位替换从不落库（持久化的只有 Macro 摘要+游标），命令路径只要纯粹的 Macro 摘要。
- 摘要落库（`appendHistorySummary`）是唯一提交点；手动压缩明确写 `turnId=null`。abort / 失败即历史原样，abort 返回 `{ status: 'cancelled' }` 而非错误。
- 每次实际发出的摘要请求都有独立调用 ID. 请求进入 Provider 前先写 `running`, 收到完整流、失败或取消后再把同一行更新为终态. 分段和重试不会聚合成一笔, 手动压缩不铸造 `turnId`.
- 成功响应的 before/after/saved（+ 窗口截断计数）用于压缩结果提示。Context 圆环丢弃压缩前的值, 按已保存的摘要及未覆盖尾部重新估算, 不把 `afterTokens` 当作下一轮输入实报。

## 错误

`CommandsError.code`：`nothing_to_compact`（空历史）、`compact_below_threshold`（历史低于窗口 manualMinRatio）、`compact_failed`（macro 失败，附 Provider 原因）、`provider/not_configured`（Session 无模型偏好或模型未启用）。`SessionBusyError` 从 session 包原样上抛。
