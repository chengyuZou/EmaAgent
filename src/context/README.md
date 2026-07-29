# @ema-agent/context

Context 负责把持久化历史、当前输入、Prompt 与 Tool Manifest 组织成模型可见上下文。它决定哪些内容进入请求、历史媒体怎样降级以及缓存前缀在哪里结束，但不调用 Provider API，也不保存通用记忆。

`contextSnapshot.ts` 集中定义单次模型调用的不可变输入、输出和缓存诊断；`types.ts` 保留 Context Contribution 与压缩协作契约，避免快照身份继续散落在通用类型文件中。

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
- `promptPrefix.ts`：保留 Tool Manifest 已冻结的数组顺序、规范化 Schema key，并计算缓存边界之前的前缀指纹；
- `contextCompactor.ts`：按 Token 预算执行微压缩、结构化摘要、必要运行态恢复与连续失败熔断；
- `compaction/`：保存纯函数预算、Tool 配对安全切点和摘要 Prompt；
- LLM Adapter 仍负责把 `cacheBreakpoint` 翻译成 Anthropic `cache_control` 等具体协议字段；

ContextAssembler 会在最终请求投影的最后一条非空消息上补充增量缓存断点，使历史和已经完成的工具轮次进入下一次请求的缓存前缀。该断点不写回 Session Message、当前 Turn 工作消息或压缩结果；普通装配和压缩装配都会按各自最终顺序重新计算位置。

## 装配后的 Message 长什么样

`ContextAssembler` 把输入拼成 `[prefix, history, suffix]` 三段，再在尾部补一个增量断点。下图是一次 Work Turn（已有几轮工具历史）实际产出的 `ModelContextSnapshot.messages`：

```text
messages[]                         来源                          cacheBreakpoint
──────────────────────────────────────────────────────────────────────────────
┌─ system  ──────────────────── PromptSnapshot.systemBlocks[0] ── ✅(product)─┐
│ # Ema 基本行为 / # 工具使用通用原则                                         │
├─ system  ──────────────────── PromptSnapshot.systemBlocks[1] ── ✅(char)──┤
│ ## 角色身份 / ## 角色表达控制协议                                           │
├─ system  ──────────────────── PromptSnapshot.systemBlocks[2] ── ❌(turn)──┤
│ ## 当前执行方式：Work / ## 剧情资料策略：自动                              │
├─ user    ──────────────────── PromptSnapshot.contextBlocks[0] ── ❌──────┤
│ ## 可用技能（extension，非 system 指令）                                   │
├─ user    ──────────────────── runtimeEnvironment ─────────────── ✅ ─────┤
│ # 本轮运行环境（日期/平台/工作区/模型）                                    │
└──────────────────────────────────────────────────────────────────────────┘
   ↑ 以上是 prefix，不可压缩，进压缩器只算预算不进摘要模型

┌─ user    ─── 历史第1轮问题 ───────────────────────────────────────────────┐
├─ assistant ─ [tool_use Read] ────────────────────────────────────────────┤
├─ user    ─── [tool_result] ──────────────────────────────────────────────┤
├─ assistant ─ 文本回复 ───────────────────────────────────────────────────┤
│   ... history（可压缩；Macro 摘要只动这一段） ...                         │
└──────────────────────────────────────────────────────────────────────────┘
   ↑ history 由 messageBuilder 从 Session Message 投影而来，
     thinking 与 UI 字段已剥离，tool_use/tool_result 配对完整保留

┌─ user    ─── Contribution(beforeCurrentTurn)：Memory/Narrative 召回 ─────┐
├─ user    ─── currentTurn：本轮用户输入 ──────────────────────────────────┤
├─ user    ─── Contribution(afterCurrentTurn)：Scratchpad/Mailbox ─────────┤
│   ... suffix ...                                                          │
├─ user    ─── 最后一条非空消息 ───────────────────────── ✅(尾断点,自动补)─┤
└──────────────────────────────────────────────────────────────────────────┘
   ↑ suffix 是本轮临时数据，不进摘要模型，但计入预算
```

要点：

- **prefix 不可压缩**：systemBlocks + contextBlocks + environment。进压缩器只算 token 预算，不进摘要模型。product/character 块带断点，turn 块不带。
- **history 可压缩**：Macro 摘要只替换这一段。`messageBuilder` 投影时已剥 thinking、保留 tool 配对。
- **suffix 是本轮临时数据**：`ContextContribution`（memory/narrative/scratchpad/mailbox）按 `placement` 插在 currentTurn 前后，不能伪装成历史。
- **尾断点自动补**：`markFinalCacheBreakpoint` 从尾部往前找第一条非空消息标 `cacheBreakpoint`，使 history 进缓存前缀。这个断点只在请求投影上，不写回 Session/压缩结果。
- **`cache` 诊断块**：快照还带 `productPromptRevision/activeCharacterRevision/turnPromptRevision/toolManifestRevision/prefixHash`，任一变化即可定位缓存断裂来源。

## 压缩后的 Message 长什么样

Macro 压缩后，history 被摘要替换。prefix 和 suffix 原样保留，只有 history 段变成 `[summary, restore, tail]`：

```text
messages[]                         来源                          cacheBreakpoint
──────────────────────────────────────────────────────────────────────────────
  prefix（同上，原样保留）               ✅ product/char/env 断点
──────────────────────────────────────────────────────────────────────────────
┌─ user    ─── <context-summary profile="work"> ──────────────────────────┐
│              ... Macro 摘要（<summary> 内容，analysis 已丢弃） ...       │
├─ user    ─── required restore（例如 active-skill）───────────────────────┤
│              只恢复 Macro 会从历史中移除的 Agent 运行态                  │
├─ ... tail（保留的最近 ~25% 原文，tool 配对完整）... ────────────────────┤
└──────────────────────────────────────────────────────────────────────────┘
  suffix（同上，原样保留）                 ✅ 尾断点自动补
──────────────────────────────────────────────────────────────────────────────
```

Safe Cut 保证 tail 内每个 `tool_result` 的 `tool_use` 也在 tail 内（按 `toolUseId` 全表配对验证）。找不到安全切点（历史已损坏）时整段 history 文本化后交 Macro 摘要，失败计入 Session 熔断。

V1 使用渐进式压缩：现有 ToolResultStore 先把超大结果落盘；只有上下文接近模型硬限制时才执行 Micro Compaction；仍超限才调用当前模型生成摘要。API 超限时由 Agent 触发一次 Reactive Compaction。Context Collapse、服务端 cache edits 和后台 Session Memory Agent 延后评估。

Compaction 只按 `ExecutionProfile = chat | work` 选择摘要结构；`NarrativePolicy` 只控制剧情检索，不会创建第三套压缩语义。Macro 摘要要求模型先生成 `<analysis>` 草稿再输出 `<summary>`，解析器只保留最终摘要。Safe Cut 按 `toolUseId` 验证保留尾部的完整配对，允许从 assistant `tool_use` 开始，但不会让 tail 留下来自摘要 head 的孤立 `tool_result`。

System Prompt 属于不可压缩前缀。即使响应式压缩接收到完整请求视图，也必须先将 system message 与历史分离；摘要模型只处理历史，压缩结果原样恢复 System Prompt。

Memory、Narrative、Scratchpad 和 Mailbox 属于本轮临时数据，通过带来源、唯一 ID 和插入位置的 `ContextContribution` 进入装配器；它们不能伪装成持久化历史。Skill Catalog 属于 Prompt Context Slot，激活后的完整 Skill 则由当前 Agent 独立保存；正常工具轮次依赖原始 SkillCall Result，只有 Macro 真正改写历史后才通过 `postCompactionRestoreContributions` 恢复，避免每轮重复正文。该恢复状态属于 `requiredRestoreMessages`，预算不足时压缩失败，不能静默丢 Skill。`assembleCompacted()` 会把固定 Prompt、可压缩历史、临时贡献、恢复状态与当前 Turn 分开交给压缩器，只有历史允许进入摘要模型。

Conversation 与 Agent 根 Turn 已直接使用该入口。Agent 每次逻辑迭代重新装配 Scratchpad、Mailbox 和当前可见 Tool Manifest；Skill 调用收窄工具后，下一次 LLM 请求会得到新的 Manifest revision。`beforeLlm` Hook 仍可观察或调整最终请求，但 Prompt、Memory、Narrative 与 Skill 不再依赖 Hook 优先级完成核心装配。

压缩阈值按 `contextWindow - reservedOutputTokens - bufferTokens` 计算。模型目录提供 `maxOutput` 时使用真实值，否则默认预留 8K；预留上限为 20K，安全缓冲为 13K。连续三次摘要失败后按 Session 熔断，避免重复消耗模型调用。

所有 Context 状态必须按 Session/Turn 快照隔离，禁止使用会在多个并行 Session 之间共享可变内容的模块级缓存。
