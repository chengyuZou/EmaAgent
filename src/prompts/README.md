# @ema-agent/prompts

EmaAgent 的模型指令装配模块。它只校验、排序和版本化各业务模块提供的 `PromptSlot`，不读取数据库，也不拥有 Character、ACT、Memory、Narrative 或 Tool Schema 的业务规则。

## 当前边界

```text
Character ── Identity / Presentation ──┐
Product ─── 固定规则与工具原则 ────────┼─> PromptAssembler ─> PromptSnapshot
Profile ─── Chat / Work 行为 ──────────┘

Memory / Narrative / KB ─> ContextContribution
ToolRegistry ────────────> ToolManifestSnapshot
```

- Character 负责角色身份和模型可见的 ACT 表达说明。
- Emotion 负责解析模型输出中的 ACT 标签并生成逻辑 `StageCue`。
- Live2D 负责把 `StageCue` 映射为具体模型资源。
- ContextAssembler 负责把 Prompt、历史、召回、当前输入和 Tool Manifest 组成最终模型请求。
- Hook 不承担新主链的 Prompt 装配；`registerPromptsHooks` 仅供旧 Engine 迁移期间兼容使用。

## 文件结构

```text
├─ types.ts                 PromptSlot、缓存范围、信任来源和快照
├─ errors.ts                Prompt 装配错误
├─ promptAssembler.ts       校验重复 ID、稳定排序并计算 revision
├─ build.ts                 旧 Engine 的 System Prompt 兼容入口
├─ mode-blocks.ts           尚待迁移的旧三模式指令
├─ hooks.ts                 尚待 ContextAssembler 接管的兼容 Hook
└─ tests/
```

## 约束

- 业务模块只提交 `id`、`content` 和 `version`；Assembler 根据受控 Slot ID 决定 `kind`、`order`、`cacheScope` 和 `trust`，调用方不能把自身插到产品规则之前。
- 输出 Slot 始终具有明确 `id`、`kind`、`order`、`content`、`version`、`cacheScope` 和 `trust`。
- 重复 Slot ID、空内容、空版本或非法顺序会直接报错，不允许静默覆盖。
- `PromptSnapshot.revision` 根据排序后的完整 Slot 身份计算，不依赖调用方插入顺序。
- Tool Result、网页、附件、Memory、KB 和 Narrative 是上下文数据，不得作为可信 PromptSlot 注入。
- Tool Schema 通过 `ToolManifestSnapshot` 发送，不复制进 System Prompt。

当前 `buildSystemPrompt()` 仍接受旧 `TurnMode`，用于保持现有 Agent/Conversation Engine 可运行。Chat/Work 与 `NarrativePolicy` 接入后应删除这层兼容，而不是继续扩展旧三模式。
