# @ema-agent/prompts

> EmaAgent 的系统提示词工程与组装包 —— 负责基于状态注入系统上下文与 ACT 动作标签规范。
> 架构重构后，本包全权掌控 `buildSystemPrompt` 及 `ACT` 标签解析职责。

---

## 整体架构

```
                     ┌────────────────────────────────┐
                     │         Prompts Builder        │
                     │                                │
 Card ──────────────►│   ┌────────────────────────┐   │
                     │   │ buildSystemBlock(card) │   │
                     │   │   → systemPrompt       │   │
                     │   │   → buildActBlock()    │   │
                     │   └──────────┬─────────────┘   │
                     │              │                 │
                     │  ┌───────────▼─────────────┐   │
 Mode / SubMode ────►│  │ buildModeBlock(mode)    │   │
                     │  │   → Narrative / Chat    │   │
                     │  │   → Agent Constraints   │   │
                     │  └───────────┬─────────────┘   │
                     │              │                 │
                     │ ┌────────────▼───────────────┐ │
                     │ │ buildSystemPrompt()        │ │
                     │ │ return block1 + block2     │ │
                     │ └────────────────────────────┘ │
                     └────────────────────────────────┘
```

模块提供：
- **`buildSystemBlock` 迁移接管**：从 character-card 中接管角色底层系统提示词及 `ACT` 标签词汇表的下发。
- **Turn 级别的 Mode 控制**：基于回合模式（Chat, Narrative, Agent）动态切换 LLM 行为边界。
- **提示词缓存友好设计**：记忆召回（RecallBundle）不在本包内直接硬编码拼接为 System Prompt，而是作为特定 user 消息由 orchestrator 统一 append。本包输出的始终是稳定的上下文头。

---

## 文件结构

```
src/
├── index.ts           # 入口，统一导出组装相关的函数
├── build.ts           # 核心组装主逻辑，涵盖 buildSystemPrompt 与 buildSystemBlock
└── mode-blocks.ts     # TurnMode 模式策略相关提示词组装实现
tests/
└── build.spec.ts      # Vitest 单元测试
```

---

## 核心设计要点

### 1. 接管 System Block 与 Act 规范映射
`packages/character-card/src/system-block.ts` 已被废弃，现在 `buildSystemBlock(card)` 完全由 `@ema-agent/prompts` 管理。该函数从数据对象 `CharacterCard` 中提取 `systemPrompt`，并利用该角色的 `emotionVocabulary` 和 `motionVocabulary` 生成一套完整的「ACT 内联标签协议」：
例如将表情列表 `['happy', 'sad']` 转换为向大模型下发的标签可用范围说明（`['<|ACT:emotion:happy|>', '<|ACT:emotion:sad|>']`），并教授大模型在回复语句体中进行标签内嵌操作的规范要求。

### 2. 提示词工程的统一管控
作为单独的 Prompt Engineering 领域模块，本包屏蔽了底层零散字段的拼写细节，暴露出 `buildSystemPrompt` 作为统一入口：

```typescript
export function buildSystemPrompt(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): string;
```

其输出固定包含：
1. **Character block**：Persona 和可用的 ACT 标签语义指导。
2. **Mode block**：针对当前对话模式（例如纯聊天或调用工具做系统控制的 Agent 模式）的行为准则约束。

### 3. 可测试与高内聚
由于不涉及 SQLite 数据库直接读写与具体的 Hook 逻辑处理，本包处于应用逻辑编排的无副作用阶段。通过注入 Mock 卡片或者不同的 `TurnMode` 枚举定义，即可快速在 `tests/build.spec.ts` 中针对各种业务分支与 System Prompt 组装预期结果进行全量覆盖的文本断言比对测试。