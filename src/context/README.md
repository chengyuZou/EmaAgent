# @ema-agent/context

Context 负责把持久化历史、当前输入、Prompt 与 Tool Manifest 组织成模型可见上下文。它决定哪些内容进入请求、历史媒体怎样降级以及缓存前缀在哪里结束，但不调用 Provider API，也不保存通用记忆。

```text
Session Message
    ↓ messageBuilder
Provider ModelCapabilitySnapshot
    ↓ messageCompatibility
Prompt / Tool Manifest
    ↓ ContextAssembler
ContextCompactor
    ↓ Micro → Macro → Restore
模型可见 Message + 稳定前缀诊断
```

当前边界：

- `messageBuilder.ts`：把 Session Message 投影为 Provider 无关的模型 Message；thinking 与 UI 展示字段不重放，成对的 `tool_use/tool_result` 事实必须保留；
- `messageCompatibility.ts`：替换当前模型无法重放的历史媒体，并拒绝本轮不受支持的输入；
- `contextAssembler.ts`：按固定边界合并 PromptSnapshot、历史、当前 Turn、临时贡献和 ToolManifestSnapshot，返回不可变模型请求快照；
- `promptPrefix.ts`：生成顺序稳定的 Tool Manifest，并计算缓存边界之前的前缀指纹；
- `contextCompactor.ts`：按 Token 预算执行微压缩、结构化摘要、恢复与连续失败熔断；
- `compaction/`：保存纯函数预算、Tool 配对安全切点、摘要 Prompt 和压缩后恢复；
- LLM Adapter 仍负责把 `cacheBreakpoint` 翻译成 Anthropic `cache_control` 等具体协议字段；

ContextAssembler 会在最终请求投影的最后一条非空消息上补充增量缓存断点，使历史和已经完成的工具轮次进入下一次请求的缓存前缀。该断点不写回 Session Message、当前 Turn 工作消息或压缩结果；普通装配和压缩装配都会按各自最终顺序重新计算位置。

V1 使用渐进式压缩：现有 ToolResultStore 先把超大结果落盘；只有上下文接近模型硬限制时才执行 Micro Compaction；仍超限才调用当前模型生成摘要。API 超限时由 Agent 触发一次 Reactive Compaction。Context Collapse、服务端 cache edits 和后台 Session Memory Agent 延后评估。

Compaction 只按 `ExecutionProfile = chat | work` 选择摘要结构；`NarrativePolicy` 只控制剧情检索，不会创建第三套压缩语义。Macro 摘要要求模型先生成 `<analysis>` 草稿再输出 `<summary>`，解析器只保留最终摘要。Safe Cut 按 `toolUseId` 验证保留尾部的完整配对，允许从 assistant `tool_use` 开始，但不会让 tail 留下来自摘要 head 的孤立 `tool_result`。

System Prompt 属于不可压缩前缀。即使响应式压缩接收到完整请求视图，也必须先将 system message 与历史分离；摘要模型只处理历史，压缩结果原样恢复 System Prompt。

Memory、Narrative、Scratchpad 和 Mailbox 属于本轮临时数据，通过带来源、唯一 ID 和插入位置的 `ContextContribution` 进入装配器；它们不能伪装成持久化历史。Skill 指令属于 Prompt Slot，不进入数据贡献列表。`assembleCompacted()` 会把固定 Prompt、可压缩历史、临时贡献与当前 Turn 分开交给压缩器，三部分共同计入预算，但只有历史允许进入摘要模型。

Conversation 与 Agent 根 Turn 已直接使用该入口。Agent 每次逻辑迭代重新装配 Scratchpad、Mailbox 和当前可见 Tool Manifest；Skill 调用收窄工具后，下一次 LLM 请求会得到新的 Manifest revision。`beforeLlm` Hook 仍可观察或调整最终请求，但 Prompt、Memory、Narrative 与 Skill 不再依赖 Hook 优先级完成核心装配。

压缩阈值按 `contextWindow - reservedOutputTokens - bufferTokens` 计算。模型目录提供 `maxOutput` 时使用真实值，否则默认预留 8K；预留上限为 20K，安全缓冲为 13K。连续三次摘要失败后按 Session 熔断，避免重复消耗模型调用。

所有 Context 状态必须按 Session/Turn 快照隔离，禁止使用会在多个并行 Session 之间共享可变内容的模块级缓存。
