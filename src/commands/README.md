# @ema-agent/commands

Command 是用户显式触发的确定性产品操作，在创建 Turn 之前处理。V1 只有一个真实行为：`/compact` 直接改写 Session 历史，**不创建 Turn**。

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

## /compact 链（冻结语义）

```text
生成 compactId
→ ActiveSessionRegistry.register(sessionId, { kind: 'compact', compactId })   // 撞坑即 SessionBusyError
→ loadHistory → deriveLlmHistory（generatedBy 解析与根 Turn 共用 createGenerationTargetResolver）
→ 手动下限闸：历史估算 < 窗口 × settings.manualMinRatio（默认 15%）拒绝 compact_below_threshold
  ——只量可压缩历史本身；高于它用户随时可主动整理，不等 85% 自动触发线
→ getSystemPrompt（与下一根 Turn 同事实装配）→ buildPromptMessages → systemMessages
→ compact(force=true + micro=false，终态必是 macro；tools=[]、推理强度沿用 Session)
→ saveMacroSummary：summarizedMessageCount → historyWithIds 游标映射 → appendHistorySummary
→ ManualCompactResult { beforeTokens, afterTokens, savedTokens, durationMs, truncated*? }
finally 释放坑位
```

- **活跃模型：Session 是活跃的唯一载体**。Turn 与手动压缩是同一坑位的两种占用形态；手动压缩期间不存在 Turn 活跃，反之亦然（撞坑同一个 `SessionBusyError`）。
- **停止是 Session 级操作**：Desktop 把当前 `ActiveSession` 原样发给
  Session WebSocket 的 `cancel_active_session`. Registry 只取消身份仍匹配的 Turn
  或手动 Compact, 迟到的按钮不会停掉同 Session 后来开始的工作. 自动压缩活在
  根 Turn 内部, 与 Turn 共用取消信号, 不另外占用 Active Session.
- 模型解析与下一根 Turn 同规则：`Session.providerId/modelId`，未配置即 `provider/not_configured`；缓存共享是向前的（下一 Turn 读压缩后历史）。
- 摘要请求形状：同字节 systemMessages + 结构化历史 + 尾部指令（Codex 本地 compact 同款）。`tools` 恒空：根 Turn 的 ToolPool 装配需要 Turn 身份（SubagentSpawner/scratchpad/narrative 事件归因），Turn 外伪造身份被禁止；因此历史边界缓存断点在手动路径架构性不可达，可共享的是静态产品段 + 动态尾到 execution-profile 的前缀。手动路径直接读取 Session 的推理强度, 不借用不存在的根 Turn 选择。
- `micro:false`：Micro 的占位替换从不落库（持久化的只有 Macro 摘要+游标），命令路径只要纯粹的 Macro 摘要。
- 摘要落库（`appendHistorySummary`）是唯一提交点；abort / 失败即历史原样，abort 返回 `{ status: 'cancelled' }` 而非错误。
- 摘要调用经 `usageRecorder` 记账(`callId=compact:<compactId>`, 不铸造
  turnId/llmCallId). 零消耗不记账.
- 成功响应的 before/after/saved（+ 窗口截断计数）用于压缩结果提示。Context 圆环丢弃压缩前的值, 按已保存的摘要及未覆盖尾部重新估算, 不把 `afterTokens` 当作下一轮输入实报。

## 错误

`CommandsError.code`：`nothing_to_compact`（空历史）、`compact_below_threshold`（历史低于窗口 manualMinRatio）、`compact_failed`（macro 失败，附 Provider 原因）、`provider/not_configured`（Session 无模型偏好或模型未启用）。`SessionBusyError` 从 session 包原样上抛。
