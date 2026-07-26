# EmaAgent 统一 Turn Runtime 与契约拆分 RFC

> 状态：设计中，不代表当前源码已经完成迁移  
> 日期：2026-07-21  
> 范围：后端统一引擎、业务契约拆分、Prompt 插槽、Context/Compaction、Narrative Tool、前端 Chat/Work，以及剩余发布前问题  
> Artifact：继续由 V1 Feature Gate 禁用，不进入本 RFC
>
> Claude Code 全量文档逐章 Diff、Ema 目标边界与迁移顺序见 `EmaClaudeArchitectureReview.md`。本 RFC 负责实施范围，评审文档负责参考依据；两者冲突时以本 RFC 后续明确决策和实际源码为准。

## 0. 重构前的参考与核验流程

本轮不是根据单篇文章或单个目录模仿 Claude Code。每个主要业务批次开始前，必须把 Ema 当前事实、目标设计、参考理由和真实源码放在一起核对：

1. 完整阅读 `CLAUDE.md` 与 `EmaWorkState.md`，确认长期规则、当前施工阶段、工作区归属和最近验证；
2. 阅读本 RFC 的对应章节，确认本批目标边界、明确延期项和不能混改的业务；
3. 阅读 `EmaClaudeArchitectureReview.md` 的对应章节及其前后接口章节，确认设计理由和跨模块约束；
4. 阅读 `D:\Github\how-claude-code-works\docs` 中与本批直接相关的文档，并检查 Agent Loop、Context、Tool、Hook、Permission、Task、Observability 等关联章节是否能首尾接通；不能只读一个章节便照搬局部实现；
5. 对重要或存在疑问的结论，继续核对本地 `D:\Github\claude-code` 的真实源码。参考文档与源码不一致时，先记录差异，再以源码行为为事实依据；
6. 最后完整阅读 Ema 对应调用链和测试，分别写清“Claude 事实、Ema 事实、差异判断、采用或不采用的理由”，再开始修改。

`how-claude-code-works/docs` 的二十余篇文档是同一套 Agent 架构的不同切面，不是互相独立的功能清单。例如 Tool 重构除了第 04 章，还必须联动 Agent Loop、Context Engineering、Code Editing、Hooks、Permission、Skills、MCP、Task System、Observability 与后台执行；Turn Runtime 重构则必须回查 Tool、Context、Memory、Plan、Goal、Workflow 和多 Agent 的身份与终态边界。

Claude Code 是重要工业参考，不是 Ema 的产品规范。Ema 是本地优先、单人使用、跨平台并包含角色表达、Memory、Knowledge Base 与 Narrative 的桌面 Agent。可以大胆修正已经证明错误的旧接口和目录，但不能复制 Claude 的企业、多用户、coding-only、Bun/Ink 或内部 Feature Flag 结构，也不能为了外观相似预建 V1.5 空能力。

每批完成后只把当前进度、验证和下一步写入 `EmaWorkState.md`；长期目标变化更新本 RFC；新的设计依据和 Claude Diff 写入 `EmaClaudeArchitectureReview.md`，避免三个文档互相复制成长篇日志。

## 1. 为什么现在要重构

Ema 当前已经具备 Turn、SSE、工具、权限、Sandbox、Memory、Narrative、Skill、MCP 和多模型能力，但这些能力仍被旧的三个 Mode 和大量细包切开：

- `ConversationEngine` 负责 `chat/narrative`，`AgentEngine` 负责 `agent`；
- `narrative` 本质上是多周目剧情 RAG，却被建模成顶层执行模式；
- `agent-context` 实际混合文件快照与工具结果，并不是完整的模型上下文系统；
- `agent-task` 同时表达根 Turn 投影、等待用户、子 Agent 与 transcript，和 Turn 状态重叠；
- Compaction 放在 Memory 包内，导致长期记忆与模型窗口治理互相污染；
- `apps/core` 直接依赖二十多个内部包，`AppBindings` 已接近 Service Locator；
- Prompt 没有稳定插槽与缓存边界，角色、Mode、MCP、Skill、工具变化容易破坏 KV Cache。
- 中央 `contracts` 已混入模型内部消息、数据库持久化结构、前端 Wire、各业务事件、ID、Usage 与错误码，失去明确所有者；
- 同一个“Message”同时表达 Session 记录、模型输入和前端 DTO，导致历史转换、媒体降级和持久化展示互相渗透。

本轮目标不是换目录名字，而是先确定唯一运行语义，再做可验证迁移。

当前已经完成的地基：Provider 与 LLM 已迁入根 `src`；LLM 使用 `LanguageModel` 作为业务接口、`LanguageModelRuntime` 作为 Core 装配实现，并已建立 Provider 原子快照、`llmRequestPreparer`、明确流终态和连续 Block Index。第二轮又完成了 LLM 自有 `Message/ContentPart/AssistantBlock/LlmCallId/LlmTokenUsage`、跨模态 `usage` 写入端口和 Context `messageBuilder`；LLM 生产代码已不再依赖 `packages/contracts`。后续不能再按旧 `LlmRouter` 或 `packages/llm` 设计。

## 2. 已确定的产品语义

### 2.0 Turn 是有界执行，不只是一条用户消息

`Turn` 表示一次具有明确触发原因、开始时间和唯一终态的 Agent 决策与行动。V1 的触发源只有用户消息，但领域定义不能把 Turn 永久绑定为 HTTP `/chat` 请求；未来屏幕观察、外部渠道消息、Realtime handoff、主动策略或 Schedule 都可以在通过各自信任与唤醒策略后创建新的 Turn。

长期音频、屏幕观察和直播不能建模成一个持续数小时的 Turn。它们属于附着于 Session 的 `RealtimeSession` 或活动会话，负责媒体连接、转写、感知和表现；只有出现需要模型决策的语义输入时才创建一个有界 Turn。一个直播活动可以包含多个独立 Turn。

```text
Session
├─ RealtimeSession / future LiveSession
│  └─ 音频、画面、WebSocket/WebRTC、TTS 与舞台输出
└─ Turn
   └─ AgentLoop：在该 Turn 内重复执行 LLM → Tool → Result
```

Vision 是感知能力，主动说话是唤醒策略，WebSocket 是传输协议，直播是长生命周期活动；它们都不是新的 `ExecutionProfile`。V1 只实现用户消息触发，不建立未来触发器、Realtime 或直播空包，但 Turn 启动契约应保留明确的 trigger/origin 扩展位置，且任何非用户来源都不能构成危险 Tool 的用户授权。

### 2.1 用户只看到 Chat 与 Work

```ts
export type ExecutionProfile = 'chat' | 'work';

export type NarrativePolicy = 'auto' | 'always' | 'off';
```

- 一个 Session 内可以在 Chat 与 Work 之间切换；
- 每个 Turn 保存当时的 `executionProfile`，历史不能被 Session 后续切换改写；
- Session 保存下一轮默认 Profile；
- `narrative` 不再是顶层 Mode，而是可供 Chat/Work 使用的剧情检索能力；
- Chat 的二级菜单提供“剧情资料：自动 / 始终 / 关闭”，默认 `auto`。

Chat/Work 只描述一次 Turn 的执行能力和安全范围，不描述输入设备、连接协议或角色是否正在直播。

`off` 只关闭剧情数据库检索，不移除 Character Prompt。UI 应提示：角色基础设定仍保留，但可能缺少剧情细节或混淆周目。

### 2.1.1 Session 历史保持线性，Fork 创建独立 Session

V1 不保留同一个 Session 内的 Branch 树。Branch 会让 Message、Turn、附件、Task、AgentRun、Permission 与外部副作用同时面对“当前分支”语义，删除中间节点也无法诚实撤销已经执行的文件和网络操作。

- Session 侧栏的 Fork 完整复制当前 Session，不需要 TurnId；
- 已完成助手回复下的 Fork 复制到该回复所属 Turn（含）为止，并立即进入新的独立 Session；
- 用户消息不提供 Fork；只有最后一条用户消息可以回滚最后一个非运行 Turn 后重新发送；
- V1 不提供任意历史 Turn 删除。整个 Session 仍可归档或删除；
- Fork 复制 Session、Turn、Message 与附件身份，不复制活动 Task、AgentRun、Permission 请求或外部副作用；
- `parentSessionId` 只用于说明副本来源，不代表两个 Session 继续共享可切换的历史树。

旧 Branch 的 Binary Lifting、Euler Tour + RMQ、恢复顺序与前端树形布局已原样保存在工作区外的 `D:\Github\EmaAgentBranchArchive`，未来若恢复该能力必须先重新定义跨领域副作用和 Task/AgentRun 的分叉语义。

### 2.2 统一执行核心是 TurnExecutor + AgentLoop

统一执行核心不再由 `ConversationEngine` 与 `AgentEngine` 各自维护一套循环。高层 `turnExecution/TurnExecutor` 管一次 Turn 的根生命周期，低层 `turn` 只保留领域契约；`AgentLoop` 只管一个 Turn 内可重复的 LLM、Tool 与 Result 迭代。旧 `AgentEngine` 的成熟职责已经迁入 `TurnExecutor` 并删除，不能再增加第三层包装：

```text
TurnExecutor
  创建、取消、唯一终态、持久化、事件身份、TurnHandle
      ↓
AgentLoop
  Context → LLM → Tool Batch → Result → LLM
```

`TurnExecutor.start(command)` 返回立即可用的 `TurnHandle`：稳定的 `sessionId/turnId`、`AsyncIterable<TurnEvent>`、唯一完成的 `Promise<TurnOutcome>` 与取消入口。`AgentLoop` 返回循环内部事件和 `AgentLoopOutcome`，不创建或结束根 Turn，不直接写 Session Repo，也不直接面向 HTTP/SSE。

`src/conversation` 只是迁移期边界，不是目标模块。迁移时必须沿真实调用链拆分其职责：根 Turn 请求、Profile 与执行生命周期进入 `src/turnExecution`，低层状态与事件契约留在 `src/turn`，模型可见窗口贡献进入 `src/context`，Narrative 检索与路由回到 `src/narrative`，Hook 观察能力继续由 `src/hooks` 所有，LLM/Tool 迭代只留在 `src/agent`。迁移完成后删除 `src/conversation` 的源码、测试、Workspace 配置与所有 import；不能把整个包复制或改名成新的 Engine、Service、Facade。

```ts
export interface TurnExecutionProfile {
  id: ExecutionProfile;
  maxIterations: number;
  allowedToolIds: readonly ToolId[];
  allowShell: boolean;
  allowFileWrite: boolean;
  allowSubagents: boolean;
  requireWorkspace: boolean;
}
```

Chat 与 Work 使用同一套模型循环、Hook、事件、工具准备、终态和错误协议，仅执行策略不同：

| 能力 | Chat | Work |
|---|---:|---:|
| 日常对话与角色表达 | 是 | 是，但服从任务优先级 |
| NarrativeSearch | 按 NarrativePolicy | 按 NarrativePolicy |
| 附件只读 | 有界、只读 | 有界、只读 |
| KB/Memory 查询 | 只读 | 只读 |
| Shell/文件写入 | 否 | 经 Permission + Sandbox |
| MCP/Skill | 受限集合 | 完整策略集合 |
| 子 Agent | 否 | 是 |
| 最大循环 | 低，例如 3 | 高，由 Turn Budget 决定 |

安全边界不能为了缓存命中率而发送一个“工具全集”再靠 Prompt 劝模型不用。模型看不见的工具才是真正不可调用。

## 3. Narrative 是独立 Tool，也是独立业务块

### 3.1 不删除多周目 Route

Narrative 是已经清洗完成的全剧情 LightRAG。它不需要 Narrative 会话状态机，但必须保留多周目路由：

```text
NarrativeSearchTool
        │
        ▼
NarrativeRecallFacade
        │
        ▼
NarrativeQueryRouter ── 专用 Router 模型
        │
        ├─ 1st_Loop: 改写 Query
        ├─ 2nd_Loop: 改写 Query
        └─ 3rd_Loop: 改写 Query
        │
        ▼
并行 LightRAG Query
        │
        ▼
NarrativeRecallResult
```

```ts
export interface NarrativeSearchInput {
  query: string;
}

export interface NarrativeRoute {
  timelineId: string;
  query: string;
}

export interface NarrativeRecallResult {
  routes: readonly NarrativeRoute[];
  timelines: readonly NarrativeTimelineRecall[];
}

export interface NarrativeRecallFacade {
  recall(input: NarrativeSearchInput, context: {
    sessionId: SessionId;
    turnId: TurnId;
    signal: AbortSignal;
  }): Promise<NarrativeRecallResult>;
}
```

Router 模型属于 Narrative 业务设置，不重新加入通用 `model_bindings` 的 11 项枚举。建议解析顺序：Narrative 专用模型 → 当前 Turn 模型回退 → 结构化不可用。

### 3.2 NarrativePolicy

- `auto`：向 AgentLoop 暴露 NarrativeSearch，由主模型按需调用；
- `always`：正式回答前强制执行一次 Route + Recall；
- `off`：不暴露 NarrativeSearch，也不执行强制召回。

不增加 `NarrativeSessionState`。检索结果仍可作为结构化 `narrative_context` 消息持久化，下一轮是否重新检索由 Policy 和模型判断。

### 3.3 保留独立前端展示

Narrative 成为 Tool 后仍保留业务事件：

```ts
type NarrativeEvent =
  | NarrativeRouteResolvedEvent
  | NarrativeTimelineCompleteEvent
  | NarrativeTimelineFailedEvent;
```

前端继续使用专用 Narrative Recall Block，不退化成普通 Tool JSON 卡片。标准 Tool 生命周期负责审计与取消，Narrative 事件负责剧情 UI。

## 4. Prompt 插槽与 KV Cache

### 4.1 Prompt 文本与工具 Schema 必须分开

- Prompt Slot 负责系统指令和上下文文本；
- Tool Manifest 负责 API 的 `tools` 字段；
- 不把完整 Tool Schema 再复制进 System Prompt；
- 角色专属 Narrative 使用同一个稳定 Tool Schema，角色/数据集差异放在 Prompt Slot 与执行配置中，避免换角色就改变工具 Schema 字节。

### 4.2 显式插槽

```ts
export type PromptSlotId =
  | 'core.identity'
  | 'core.safety'
  | 'core.tool_protocol'
  | 'skills.fixed'
  | 'mcp.instructions'
  | 'character.identity'
  | 'character.narrative'
  | 'profile.instructions'
  | 'workspace.environment'
  | 'context.summary'
  | 'memory.recall'
  | 'turn.current';

export type PromptCacheScope = 'global' | 'session' | 'turn';

export interface PromptSlot {
  id: PromptSlotId;
  order: number;
  cacheScope: PromptCacheScope;
  content: string;
  sourceVersion: string;
}
```

禁止 `meta: Record<string, unknown>` 一类让调用者猜字段的设计。插槽身份、顺序、稳定性和来源版本必须显式。

### 4.3 推荐顺序

```text
全局稳定前缀
  10 core.identity
  20 core.safety
  30 core.tool_protocol
  40 skills.fixed

Session 稳定前缀
  50 mcp.instructions       会话冻结快照或明确 generation
  60 character.identity
  70 character.narrative

Profile 与运行环境
  80 profile.instructions   Chat/Work
  90 workspace.environment

动态尾部
  100 context.summary
  110 memory.recall
  120 turn.current
```

注意：普通 Skill 不应全部常驻 Prompt。只有 bundled/always-on 的固定规则进入 `skills.fixed`；其余 Skill 使用 SkillSearch/SkillCall 按需展开。MCP 的工具 Schema 与 Server instructions 分开管理。

### 4.4 Tool Manifest 稳定性

- Tool Manifest 是模型工具数组顺序的唯一所有者：Builtin 按稳定内部 ID 排成连续前缀，MCP 按原始 `serverName + serverToolName` 排成连续后缀，不能在 Agent、Context 或 Adapter 再次平铺排序；
- `registryVersion` 只负责判断运行时注册表世代与旧执行快照，不能进入内容 `revision`；等价 MCP 重连不破坏缓存，描述、Schema、来源或可见集合变化才产生新 revision；
- Skill 与 Profile 只对既有 Manifest 做集合收窄并保留原顺序，不伪装成新的 Tool 来源；角色专属 Narrative 使用稳定 Builtin Tool Schema，角色和数据集差异留在 Prompt/执行配置；
- Chat/Work 各维护一个 Profile Tool Snapshot，切换后使用对应缓存前缀；
- 全局 Tool Registry 可以随 MCP 连接、断线和 `tools/list_changed` 更新，但 TurnExecutor 必须在根 Turn 开始时冻结一份 Base Manifest；同一个根 AgentLoop 的后续 LLM Call 只能读取这份快照，不能重新从全局 Registry 取工具；
- 子 Agent/Fork Agent 从父 Turn 的 Base Manifest 做能力交集，不能因为创建时间更晚而看到父 Turn 开始后才连接完成的 MCP Tool；每个 AgentRun 可以继续收窄自己的集合，但不能扩权；
- SkillCall 只允许对当前 AgentRun 的 Manifest 做单向集合收窄。收窄会产生一个明确的新内容 revision，并从下一次 LLM Call 起形成新的稳定缓存链；这是安全边界要求的有限缓存失效，不能改成“工具仍可见、执行时再拒绝”；
- MCP 连接变化不能在正在执行的 Turn 中途改写工具表。连接成功、Schema 刷新、工具新增或删除默认从下一 Turn 生效；设置页应显示“下次执行生效”，不能静默插入当前循环；
- Manifest 不只冻结模型可见 Schema，还必须绑定执行世代。MCP 重连后不能拿旧审批和旧 Schema 静默执行新实现；V1 可以让旧快照调用明确失败并提示下一 Turn 重试，但不能把 Registry 当前实现偷换进旧 Prepared Call；
- 不为追求一个缓存前缀而向 Chat 暴露 Work 写工具；
- ToolSearch、Deferred Tool 与插件贡献等到真实工具规模和正式版扩展需求出现后再设计，不为内测预建空来源类型或半成品注册层。

MCP 在本轮重构中不需要像 Builtin Tool 一样逐个审查业务语义，但必须复核四个与 Turn/Context 直接相关的边界：

1. 异步连接和 `tools/list_changed` 只更新全局 Registry，不能直接改变活动 Turn 的 Base Manifest；
2. Server instructions、Resource 和 Prompt 都是不可信外部内容，只能作为带来源的 Context Contribution 或 Tool Result，不能提升为产品 System Prompt；
3. MCP Tool 的 Schema、描述、来源身份和执行世代必须进入 Manifest/Prepared Call 的稳定身份，重连不能只按展示名替换；
4. 工具发现失败或连接尚未完成时，当前 Turn 使用已冻结的可用集合继续执行；不得为了“等 MCP”无限阻塞首个 LLM Call，也不得在后续循环突然扩充工具。

### 4.4.1 V1 的 KV Cache 世代

Ema 不把“缓存”理解成一份可以任意修改的 Session 大对象，而是把一次模型请求拆成几个有明确失效原因的前缀世代：

```text
产品规则世代
  └─ 全局角色世代
      └─ Turn Base Manifest 世代
          └─ Profile / 运行环境世代
              └─ 历史消息与已完成 Tool Round
                  └─ 当前动态尾部
```

- 产品规则只在应用版本或产品 Prompt 版本变化时失效；
- 全局激活角色变化会使角色之后的缓存失效，这是用户明确切换角色的正确代价；
- Turn Base Manifest 在根 Turn 内保持不变，MCP 异步连接不能改变它；
- Chat/Work 切换会改变 Profile 和工具可见集合，因此允许建立新的缓存链，不能为命中率向 Chat 暴露 Work 能力；
- History 每轮只追加新的 Assistant、Tool Use 和 Tool Result，最终只读 `cacheBreakpoint` 随请求尾部前移，使下一次调用复用已经完成的历史前缀；
- Memory、Narrative、附件描述、Scratchpad、Mailbox 等动态内容放在稳定前缀之后。能在 Turn 开始冻结的贡献只计算一次；真正按轮变化的内容只影响动态尾部；
- Compaction 或 Microcompact 改写旧历史时会主动开启新的 History 世代。压缩本来就是为窗口生存付出的成本，不能为了缓存命中保留已经超预算的原文；
- Provider 专属的 `cache_control` 只由对应 Adapter 投影。通用 Context 只负责顺序、断点、revision 和诊断 Hash，不把 Anthropic 字段写入通用 Message 业务模型。

### 4.5 参考项目结论

- Claude Code 使用明确的静态/动态 System Prompt boundary，并把 Tool Schema 做 Session 级稳定缓存；
- Codex 将初始指令、历史、世界状态差分和 Compaction 分开处理；
- Ema 应学习其稳定前缀和显式边界，不复制巨型单文件。

## 5. Context 与 Compaction

### 5.1 删除 agent-context 包，不删除 Context 概念

`agent-context` 曾混合文件状态、工具结果等能力，名字和职责都不准确，现已拆分并删除：

```text
原 agent-context
├─ ReadFileState       → tools/types.ts（仅当前 Turn 的编辑安全状态）
├─ ToolResultStore     → tools/results
├─ ToolResultCleaner   → tools/results 生命周期
└─ AgentContextSnapshot→ 无生产消费者，删除
```

新的 `context` 只表达“即将送进模型的上下文窗口”：

```text
context/
├─ contextAssembler.ts       Prompt Slot + messages + tool results 的唯一组装入口
├─ contextSnapshot.ts        本次组装输入、版本身份与可回放快照
├─ messageBuilder.ts         Session Message 到模型消息的安全投影
├─ messageCompatibility.ts   历史媒体降级与本轮能力校验
├─ runtimeEnvironment.ts     日期、平台、工作区与模型身份快照
├─ promptPrefix.ts           稳定前缀与缓存诊断
├─ types.ts                  Context Contribution 与压缩协作契约
└─ compaction/
   ├─ budget.ts
   ├─ safeCut.ts
   ├─ sanitize.ts
   ├─ microCompaction.ts
   ├─ macroCompaction.ts
   ├─ compactionPrompts.ts
   └─ postCompactionRestore.ts
```

V1 不为单一实现预建 `profiles/`、`serializers/` 或 `restore/` 空目录。Prompt 的协议序列化属于 LLM Adapter；只有同一职责出现多个独立实现时才升级为子目录。

### 5.2 Compaction 从 Memory 移出

Memory 只负责：

- 长期记忆提取；
- L0/L2 检索；
- Embedding/FTS；
- 衰减、维护与用户管理。

Context/Compaction 负责：

- 当前模型窗口；
- Token 预算；
- 历史规范化；
- Tool result 截断；
- 摘要压缩；
- Compaction 后恢复稳定前缀和最近 Turn。

```ts
export interface ContextAssembler {
  build(request: ContextBuildRequest): Promise<ModelContext>;
  compact(request: ContextCompactionRequest): Promise<ContextCompactionResult>;
}

export interface MemoryFacade {
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  scheduleExtraction(request: MemoryExtractionRequest): Promise<void>;
}
```

`ContextAssembler` 可以调用 Memory 的公开 Recall 入口，但不得 import Memory 内部 Repo、Runner 或 Prompt。这里不为了形式再增加 `ContextFacade`：Assembler 已经是清楚的公共入口。

Codex 的 Context 管理与 compact、AstrBot 的 `agent/context/manager + compressor` 都支持“窗口组装与长期 Memory 分离”这一边界；Ema 按自身职责命名为 `ContextAssembler`，不照搬 Manager 后缀。

## 6. AgentTask 拆为 AgentRun 与完整 Task

本节迁移已经完成：根 AgentTask 投影已删除，子执行统一为 AgentRun，跨 Turn 工作项由独立 Task 承载。

目标语义：

```text
Turn       用户发起的一轮交互，唯一根生命周期
ToolCall   一次工具执行
Task       用户/模型可见的结构化工作清单项
AgentRun   Work 模式创建的子 Agent 运行
DomainJob  KB/Vision/Embedding 等各领域后台任务
Process    后台 Shell 进程
```

根 AgentTask 不再复制 Turn 的 running/completed/failed/cancelled 状态。迁移完成后：

- `AgentTurnLifecycleFacade` 退役，Turn 成为唯一根终态；
- `agent_tasks` 中的根投影迁移或删除；
- 子 Agent 数据迁移为 `agent_runs/agent_run_messages`，前端使用独立 `AgentRunPanel`；
- AskUser 等待状态归 Turn + Prompt Registry，不依赖根 AgentTask CAS；
- Tool 副作用恢复继续由 `tool_executions` journal 承担；
- KB、Vision、Memory 不继承 AgentRun，也不强行塞进一个通用 Task 表；
- 后台 Shell 使用 `BackgroundProcessId`，不使用 TaskId 或 AgentRunId；
- V1 完整实现结构化 TaskStore，并用 `TaskCreate/Get/List/Update` 替换当前内存 `TodoWrite`。迁移完成后 TodoWrite 停止注册并删除，不保留双轨。

V1 Task 闭环包括：SQLite 持久化、事务与 CAS、Session 内短序号、显式状态、依赖关系、AgentRun 可选绑定、结构化事件、重启快照、动态 Context 提醒和独立 TaskList UI。Team、跨设备共享与实验性验证 Agent 不在 V1，但不能以此为理由把 Task 降级成 Turn 内 Todo。

V1 不把普通 Subagent 当成 Claude Team teammate。`TaskCreate/Get/List/Update` 只注册给根 Turn；子 Agent 只获得自包含指令和可选 `taskId`，不读取整张 Task List，也不直接改变 Task 状态。根 Agent 可以直接处理 Task，因此 Task 不保存 `ownerAgentRunId`。一次活动 AgentRun 可通过 `agent_runs.task_id` 独占绑定一个既有 Task；历史重试继续保留多条 Run。Run 终态只释放活动绑定，Task 是否完成由父 Turn 验证后显式提交。

在迁移前必须保留现有 CAS、恢复和 transcript 测试，避免“删了包但把断电恢复也删了”。

## 7. 目标代码结构

### 7.1 Agent-native 业务结构

```text
src/
├─ agent/
│  ├─ agentLoop.ts              唯一模型与工具迭代入口
│  ├─ events.ts                 AgentLoopEvent 与 AgentRunEvent
│  ├─ loop/
│  ├─ profiles/
│  │  ├─ chatProfile.ts
│  │  └─ workProfile.ts
│  ├─ recovery/
│  └─ runs/                     子 Agent 的 AgentRun，不放后台 Job
├─ tasks/
│  ├─ taskStore.ts              V1 持久工作项、CAS、依赖与活动 Run 校验
│  ├─ protocol.ts               Task 快照与结构化事件
│  ├─ taskContext.ts            动态 Context 提醒
│  └─ types.ts
├─ turn/
│  ├─ turnExecution/
│  │  └─ turnExecutor.ts        Turn 根生命周期与唯一终态
│  ├─ protocol.ts               TurnCommand、TurnHandle、TurnOutcome 与执行快照
│  ├─ events.ts                 只组合单个根 Turn 的实时事件
│  └─ errors.ts
├─ llm/
│  ├─ languageModel.ts
│  ├─ languageModelRuntime.ts
│  ├─ message.ts                模型调用内部 Message
│  ├─ llmRequestPreparer.ts
│  ├─ providerRuntimeRegistry.ts
│  ├─ usage.ts
│  └─ adapters/
├─ context/
│  ├─ contextManager.ts
│  ├─ contextAssembler.ts
│  ├─ messageBuilder.ts          Session Message → LLM Message
│  ├─ compaction/
│  ├─ normalization/
│  └─ budgets/
├─ prompt/
│  ├─ promptAssembler.ts
│  ├─ slots/
│  └─ cache/
├─ tools/
│  ├─ registry/
│  ├─ preparation/
│  ├─ execution/
│  ├─ results/
│  ├─ background/               BackgroundProcess 句柄、输出与取消
│  ├─ events.ts
│  └─ protocol.ts
├─ permission/
├─ sandbox/                     受限命令启动与平台隔离
├─ hook/
├─ session/
│  ├─ message.ts                 持久化 Session Message
│  ├─ protocol.ts               前端 Session/Message Wire
│  ├─ events.ts                 Task、来源等跨 Turn 的 SessionEvent
│  └─ ownership.ts
├─ narrative/
├─ memory/
├─ knowledgeBase/
├─ character/
├─ attachment/
├─ skill/
├─ mcp/
├─ providers/
├─ system/
│  ├─ events.ts                 组合角色、Provider、Memory/Knowledge 后台 AppEvent
│  └─ eventBus.ts               只接受 AppEvent 的全局通知总线
├─ usage/                        跨模型能力的调用记录与写入端口
├─ channels/
│  ├─ desktop/
│  ├─ cli/
│  ├─ web/
│  └─ integrations/             QQ、微信等平台入口
└─ bootstrap/

apps/core/src/
├─ index.ts
├─ server.ts
├─ routes/
├─ sse/
├─ auth/
└─ wiring/

packages/
├─ public-http/
└─ credential/
```

这棵树按 Agent 的真实执行路径命名，而不是按传统 DDD 分层：开发者从 `turnExecution/turnExecutor` 进入，由 `agent/agentLoop` 沿 `context → llm → tools → permission/sandbox → result` 读完一次 Turn；Narrative、Memory、Knowledge、Character 等产品能力直接是一等目录，不藏进 `capabilities`；Desktop、CLI、Web、QQ、微信只在 `channels` 提供输入输出适配，不能各自复制 Agent 编排。

根 `src` 放 Ema 产品主体；`apps/core` 只保留 Node Sidecar 入口、HTTP/SSE、认证与装配；`packages` 保留确有跨应用复用、平台隔离、独立发布或独立测试价值的技术底座。产品模块即使用独立 `package.json` 参与 TypeScript/Turbo 构建，也仍属于根 `src`，不因此成为公共库。

目录命名约束：

1. 顶层名称必须能对应 Agent 流水线或用户能理解的产品能力；
2. 不建立 `application/domain/services/managers/common/utils` 等容易变成杂物箱的顶层目录；
3. `context` 只指模型上下文，不指 React Context、文件缓存或任意“上下文对象”；
4. `agent/runs` 只保存子 Agent Run，KB/Vision/Memory 后台工作仍使用本领域 Job；
5. 每个业务目录提供稳定公开边界，名称按职责使用 `LanguageModel`、Runtime、Client、Registry、Store、函数或确有协调职责的 Facade，不强制增加 `XxxFacade`；
6. `channels` 只能把平台输入规范化为 Turn，并按作用域消费 `TurnEvent/SessionEvent/AppEvent`，不能拥有独立聊天引擎。

### 7.2 Agent 执行体系的模块所有权

本阶段按“Agent 执行体系”整体重构，不把它误解成只整理 `src/tools`。主链如下：

```text
apps/core
  Route、认证、SSE 编码、启动恢复、依赖装配
      ↓
TurnExecutor
  Turn 创建、取消、唯一终态、持久化、事件身份与 TurnHandle
      ↓
AgentLoop
  LLM → Tool Batch → Result → LLM 的迭代和预算
      ↓
ToolExecutionRuntime
  Prepare → Hook → Permission → Execute → Result
      ↓
Builtin / MCP / Skill Tool
  只实现具体能力
```

支撑模块不成为第二套编排器：`ContextAssembler` 提供每次 LLM 调用看到的窗口；`LanguageModel` 执行无 Session 状态的模型请求；Permission 决定能否执行；Sandbox 决定如何隔离执行；Storage 实现持久化端口；Session 保存持久消息与稳定 Tool Result 预览；Turn 只组合本次根 Turn 的跨端事件并拥有根终态。

**Context 装配时序**：不是 TurnExecutor 开始时只组装一次。Claude 明确规定每次 API 调用前都重新组装模型请求（消息和工具结果每轮增长）。因此 Ema 的准确边界是：TurnExecutor 提供组装所需的根事实（Session/Profile/Tool Manifest），AgentLoop 决定何时请求组装（每轮 LLM 调用前），ContextAssembler 决定怎样组装（基于最新历史/Tool Result/Recall/压缩状态）。**不能让 TurnExecutor 自己手写消息拼接规则。**

**不需要独立的 Agent Tool Scheduler**：AgentLoop 发现 Tool Calls、调用 ToolExecutionRuntime、消费结果、决定是否继续下一轮。ToolExecutionRuntime 负责并发分批/顺序/Hook/Permission/Sandbox/Journal/Result。Agent 只决定"是否继续下一轮"，Tools 决定"这一批调用怎样安全执行"。

**根 Turn 不额外产生 AgentRun**：V1 根执行由 Turn 表达，不创建重复的根 AgentRun。子 Agent/Fork Agent 才创建 AgentRun。根 Turn + 根 AgentRun 会产生两个必须保持一致的根终态（Turn.status / AgentRun.status），V1 避免。

**Sandbox 依赖方向**：Sandbox 不认识 PermissionEngine、ToolRegistry、Session/Turn 业务和 AgentLoop。正确方向是 Tools 执行流水线使用 Permission 和 Sandbox，Sandbox 本身不反向依赖 Tools（当前 `spawnProcess` 从 Tools 导入是错误依赖，待反转）。

**施工顺序**（五批，每批只改一个主要边界）：

1. **Sandbox 依赖反转**：`spawnProcess` 收回 Sandbox；合并重复 `RunOptions/RunResult`；`CommandRunner` 不再持有 `PermissionEngine`；禁用 `process.cwd()` 回退；暂时禁用 detached 假后台。不先打断 Sandbox -> Tools，后面把 ToolExecutionRuntime 迁入 Tools 会立刻形成循环依赖。
2. **Tools 主链收口**：删除 `ToolRegistry.dispatch()` 旁路；执行运行时迁入 `tools/execution`；AgentLoop 只决定何时启动和消费 Tool Batch。Ema 内置工具共享一次执行的完整 `BuiltinToolContext`，但每个 Tool 必须通过 `validateContext()` 校验并投影自己的窄 Context 后才能执行；通用 Tools 框架不拥有 Ema 业务 Port。不要恢复 `ToolInvocationContext + ToolExecutionScope` 两个万能参数袋，也不重写已正确的 PreparedToolCall/Manifest Snapshot/Result Budget/Journal。

   业务执行入口由拥有语义的模块公开：Knowledge 拥有 `KnowledgeSearchPort`，Skills 拥有 `SkillRunnerPort`，Sandbox、Tasks 与 Artifact 继续拥有各自端口。Subagent 是有意的例外：`SubagentSpawnerPort` 是 Subagent Tool 对宿主的消费契约，因此位于 `builtinTools`；Agent 结构化实现它，不能让 `builtinTools` 反向依赖 Agent 并形成包环。AskUser 同理保留为 AskUser Tool 的消费端口，由 TurnExecutor 提供实现。
3. **建立 TurnExecutor**：旧 `AgentEngine` 已迁入高层 `src/turnExecution` 并删除；下一刀收回 Turn 创建并返回 `TurnHandle`（turnId + events + completion + abort）。低层 `src/turn` 不吸收 Context、KB、Character、Tool 或后台进程依赖。
4. **清理 Agent**：`src/agent` 只保留 `agentLoop/agentLoopState/policy/budget/runs/spawner/events/errors`。
5. **Core 退回协议层**：Route 解析并验证请求；调用 `turnExecutor.start()`；把 TurnEvent 编码成 SSE。不再组装 Context、创建 Tool Executor 或决定业务终态。

当前源码的实际拆除落点已经确认：

- `src/agent/engine.ts` 已删除；其 Hook、历史读取、消息持久化、取消和唯一终态已迁入 `src/turnExecution/turnExecutor.ts`，下一刀再收回 Turn 创建；
- `src/agent/agentLoop.ts` 保留为内层循环。它在每次 LLM Call 前请求 Context 快照，消费固定的 Base Manifest 或 Skill 收窄后的子集，不创建、完成或持久化根 Turn；
- `src/conversation/engine.ts` 仍重复实现 Chat 的模型流和终态。Chat/Work 接入同一 AgentLoop 后删除整个 `src/conversation`；Narrative Recall 回到 Narrative/Context Contribution，不改名成新的 Conversation Service；
- `apps/core/src/orchestrator/orchestrator.ts` 当前同时创建 Turn、选择 Engine、解析模型、组装 Prompt/Context、合并 TTS、处理附件和写失败终态。上述业务分别迁回 Turn、Context、TTS、附件与模型所有者后删除 Orchestrator；
- `apps/core/src/routes/turns.ts` 最终只负责 HTTP 输入、认证、受限文件 capability 解析、调用 `turnExecutor.start()`、SSE replay/heartbeat 和 Wire 编码；用于补缺失身份的 `enrichTurnEvent()` 必须随完整 TurnEvent 契约一起删除；
- `apps/core/src/turn-runtime` 中的子 Agent transcript 投影迁回 `src/agent/runs`；Core 不拥有名为 turn-runtime 的第二个业务目录；
- `apps/core/src/wiring/bindings.ts` 只负责构造唯一 TurnExecutor，不同时进行全仓后台 Worker 拆分。Turn 主链跑通后再按 Route/后台任务收窄依赖，避免把语义迁移和 Composition Root 清理混成一次不可审查的大改。

一级主重构范围：

- `src/tools`：拥有 `ToolDef/buildTool`、注册与来源、Manifest Snapshot、`PreparedToolCall`、单次 Tool 生命周期、Execution Journal 领域逻辑、Result 外置与预算、后台句柄及 Presentation 数据；
- `src/builtinTools`：只实现 Ema 内置能力。MCP 与 Skill 可以接入同一 Tool 框架，但不属于 Builtin Tool；
- `src/agent`：拥有 `AgentLoop`、Profile/Policy/Budget、LLM 迭代、Tool Call 批次调度、Subagent/AgentRun 协调与循环熔断；AgentLoop 不写根 Turn 终态；
- `src/turn`：拥有 Turn 输入、触发来源、身份、状态、取消、唯一终态、持久化协调与 `TurnEvent`；它通过公共端口使用 Session Store，不直接访问 Storage Repo，也不实现 Tool 或 Prompt 细节；
- `src/agentContext`：逐项迁出后删除。Tool Result 与 Cleanup 归 `tools/results`，文件状态归 `tools/workspace` 或 `tools/files`，Snapshot 归 `context/restore` 或确认无价值后删除；
- `src/tasks`：只拥有用户或根 Agent 可见的完整 Task 系统，包括状态、依赖、活动 Run 投影、事务/CAS、查询快照与事件；四个模型 Tool 的具体定义仍在 `src/builtinTools`，并且 V1 只向根 Turn 注册。AgentRun、ToolExecution、BackgroundProcess 与领域 Job 不得继续复用 Task 身份或生命周期；
- `src/conversation`：只作 Chat 到统一 Turn 主链的短期适配器，不再拥有独立 LLM/Tool 循环，行为一致后删除；
- `apps/core`：退回 HTTP/SSE/Auth/Composition Root。Route 最终只解析请求并调用 `turnExecutor.start()`，再编码 `TurnHandle.events`；现有 orchestrator 删除或缩为协议适配器。

二级配套模块保持独立，但接口必须服从同一主链：

- `src/permission` 接收不可变 `PreparedToolCall`，管理规则、Session Grant、Prompt FIFO、路径能力与 allow/ask/deny；批准不等于已经隔离；
- `src/sandbox` 管跨平台隔离、进程树信号、网络、cwd 与挂载，通过小型 Command Runner Port 为 Tools 提供受限启动能力；后台句柄、输出、终态、LRU 与取消归 `src/tools/background`；
- `src/hooks` 观察 Prepared 调用。Hook 若修改参数，必须重新 Prepare、重新审批，不能直接执行 Tool；
- `src/session` 保存消息、Tool Result 稳定预览与引用，并参与删除生命周期，不判断是否外置或如何授权；
- `src/storage` 只实现 Repository、SQL、Migration、事务和 CAS；ToolExecution 状态机的业务定义归 Tools；
- `src/context` 只消费已经处理过的 Tool Result，并配合稳定 Tool Manifest 与缓存诊断，不重写现有 ContextAssembler；
- `src/llm` 只把 Tool Manifest 投影为各 Provider 协议，不注册 Tool，也不决定权限。

`src/tools` 的目录按真实职责逐步形成，不为目录图预建空文件夹：

```text
src/tools/
├─ definitions/       ToolDef、buildTool 与保守默认值
├─ registry/          注册来源与 Manifest Snapshot
├─ preparation/       Schema、语义校验与 PreparedToolCall
├─ execution/         单次 Tool 调用生命周期
├─ results/           外置、预算、预览与清理
├─ journal/           prepared → running → terminal 审计
├─ background/        后台句柄与取消
├─ presentation/      跨端展示数据
├─ types.ts
├─ errors.ts
└─ index.ts
```

`presentation/` 是明确的跨端数据协议，不是 React 渲染目录，也不是把所有工具输出复制一遍：

```text
src/tools/presentation/
├─ toolPresentation.ts        只汇总可判别联合
├─ fileChangePresentation.ts  根据真实 before/after 生成有界 diff
├─ fileReadPresentation.ts    路径、实际行区间与裁剪状态
├─ commandPresentation.ts     实际命令、cwd、退出与终止状态
├─ searchPresentation.ts      搜索范围、结果数量与停止原因
└─ index.ts                   公共导出
```

- 模型在 Tool Input 中提供的 `description` 是调用前的人话意图，进入 `PreparedToolCall.summary` 和 Permission 卡；它不可信，只能辅助用户理解，不能决定风险、路径或是否放行。
- `ToolPresentation` 是执行后根据 Prepared Input 和真实 Result 生成的可信界面事实；`ToolExecutionRuntime` 只传输它，Desktop、CLI、Web 各自渲染，不能反向影响 Tool Result、Permission 或 Sandbox。
- 只有需要专门展示的工具生成具体 Presentation。未知 MCP Tool 在 V1 使用通用参数/结果回退，不允许 Server 注入任意 Presentation JSON，也不为插件系统预建空分支。

每次审查 Builtin Tool，都必须结合 Claude 文档与真实源码逐项核对模型可见名称、输入 Schema、字段语义、输出、校验、只读性、并发、Permission、Sandbox、取消、超时、结果上限、流式行为、跨平台与 Presentation。Claude 的数值和字段不是默认答案；例如采用 30K 结果上限前，必须先确认双方返回内容和外置机制是否相同。

建议按 `FileRead/FileWrite/FileEdit → Glob/Grep → Bash/PowerShell → WebFetch/WebSearch → AskUser → Skill/KB/Subagent → Scratchpad → TaskCreate/Get/List/Update → Feature Gate Tool` 的顺序审查。TodoWrite 只作为迁移期旧实现，不是最终审查目标。

### 7.3 命名与文件规范

新增和迁移后的代码统一遵守以下规则；旧文件不为追求整齐而一次性全仓改名，随所属模块迁移时再处理：

1. TypeScript 文件使用 `lowerCamelCase`，例如 `definitionUtils.ts`、`llmRequestPreparer.ts`，不再新建 `model-calls.ts`、`request-scope.ts` 一类中横线文件；
2. 普通业务目录使用 `lowerCamelCase`；一个内置 Tool 独占的目录与其公开工具名一致，使用 `FileEditTool/`、`FileReadTool/` 这类 `PascalCase`；
3. class、interface、type、enum 使用 `PascalCase`，函数、变量和实例使用 `lowerCamelCase`；interface 不增加 `I` 前缀；
4. 缩写作为普通单词参与命名：类型写 `LlmUsage`、`SseEvent`、`HttpClient`，文件写 `llmUsage.ts`、`sseEvent.ts`、`httpClient.ts`，避免同一模块混用 `LLM/Llm/llm`；已有稳定产品名 `Ema` 保持不变；
5. 不使用 `_变量名` 表示未使用参数，不使用行内 `import()` 代替正常的文件顶部静态 import；确需动态加载时必须表达真实的运行时分包目的；
6. `Router` 只负责协议或路由分发，`Runtime` 负责运行期装配与生命周期，`Registry` 负责注册和快照，`Adapter` 负责外部协议转换，`Store/Repo` 负责持久化边界，`Engine` 负责完整执行循环；
7. `Facade` 只用于确实需要隐藏多个内部组件、并作为模块唯一跨模块入口的协调边界，不能把普通函数、Client、Runtime 或 Mapper 一律命名为 Facade；
8. `Service`、`Manager`、`Utils` 不作为无法说明职责时的兜底名。通用函数文件必须说明具体领域，例如 `definitionUtils.ts`；能够以 `Builder`、`Preparer`、`Policy`、`Mapper` 或具体动词命名时优先使用具体名称；
9. 源代码符号统一使用英文半角。业务注释使用中文 UTF-8，只解释业务原因、边界和非显然约束，不复述代码；
10. 除 `index.ts`、`types.ts`、`errors.ts` 外，非测试文件第一行用一句人话说明它在模块中的职责；测试统一放入模块的 `tests/` 目录，第一行说明测试的业务行为。

`Message` 等简短名称只允许在所有权明确的模块内部使用。跨模块转换文件必须通过 `SessionMessage`、`ModelMessage` 等本地别名消除歧义，不能为避免重名重新制造中央大类型。

### 7.4 根 src 迁移的验证规则

Provider 与 LLM 已证明产品模块可以位于根 `src`，同时保留内部 workspace 包名作为编译边界。后续迁移继续遵守：

1. 先保持行为做纯目录迁移，再单独修改业务；
2. 每迁一个模块都检查 Workspace、lockfile、Turbo 依赖图与旧路径残留；
3. `apps/core/dist` 不得产生依赖仓库源码路径的越界相对 import；
4. `pnpm deploy --prod` 必须收集根 `src` 模块及 native dependency；
5. release runtime 必须在没有 Git 仓库、Node 和 Python 开发环境时启动；
6. 不在同一批同时执行全仓路径移动、数据库 Schema 重构和 TurnExecutor/AgentLoop 语义切换。

### 7.5 已完成的 contracts 拆除记录

中央 Contracts 已完成拆除；本节只保留历史迁移依据，不再是下一阶段计划。业务类型、ID、事件和错误已经回到各自所有者，禁止重新建立中央类型杂物箱。

#### 类型所有权

| 当前 contracts 内容 | 目标所有者 |
|---|---|
| `LlmMessage`、模型输入 Part、模型输出 Block、`LlmTokenUsage`、`LlmCallId` | LLM |
| Session `Message`、`MessageKind`、持久化 Blocks、`SessionId/MessageId` | Session |
| `TurnRequest/Response/Stats`、`TurnId/TurnStatus/ExecutionProfile` | Turn |
| `ToolCallId`、Tool Result、Tool Presentation、执行日志 | Tools |
| Permission 风险、访问类型和确认事件 | Permission |
| `NarrativeTimelineRecall` 与 Narrative 事件 | Narrative |
| Memory Recall、Compaction、后台流水线事件 | Memory/Context，各自拥有 |
| KB Scope、Search Result 与 Ingest/Re-embed 事件 | Knowledge Base |
| `AgentKind` 与 Sub-agent 事件 | Agent |
| TTS 音频和 LipSync 事件 | TTS |
| Stage/Emotion 类型与事件 | Character/Emotion |
| Hook Invocation ID、Warning 类型与事件 | Hook |
| Provider Health 事件 | Providers |
| Attachment 元数据和前端 Wire | Attachment |
| Artifact 类型与事件 | Artifact，V1 继续禁用 |
| Usage Record/Recorder/Correlation | Usage |
| `SessionOwnershipFacade/Error` | Session |
| Release、Sandbox、Import Warning | Release/System、Sandbox、Backup |

跨业务稳定 ID 统一由零业务依赖的 `src/ids` 声明品牌和转换函数，但该模块不得容纳业务对象、状态、事件或错误。每个业务模块在自己的 `errors.ts` 导出稳定错误码；Turn 只组合一次 Turn 可能暴露给客户端的错误联合。

#### 三种 Message 必须分离

```text
Session Message                 数据库与 UI 的正式消息
       │
       ▼
Context messageBuilder          历史筛选、媒体降级、Thinking/Tool 清理、压缩
       │
       ▼
LLM Message                     单次模型调用的最小不可变输入
       │
       ▼
Provider Protocol Message       Adapter 内部 SDK 请求，不向外导出
```

Session 与 LLM 模块内部都可以使用简洁的 `Message`。只有同时接触两者的 Context 转换边界使用 `SessionMessage` / `ModelMessage` 本地别名。禁止再用一个 `MessageBlocks` 联合同时容纳数据库、模型和 UI 专属字段。

#### 事件组合

事件类型由真实业务域定义，再按生命周期范围组合；不能再由 Turn 包把整个应用拼成一个万能联合：

```ts
// src/agent/events.ts：只在模型/工具循环内部流动，不直接进入 SSE。
export type AgentLoopEvent =
  | AgentIterationEvent
  | AgentOutputEvent
  | AgentToolEvent
  | AgentUsageEvent
  | AgentBreakerEvent;

// src/turn/events.ts：单个根 Turn 的实时投影。
export type TurnEvent =
  | TurnLifecycleEvent
  | TurnOutputEvent
  | TurnToolEvent
  | TurnInteractionEvent
  | TurnContextEvent
  | TurnDiagnosticEvent;

// src/agent/events.ts：一次子 Agent 执行，可独立订阅高频详情。
export type AgentRunEvent =
  | AgentRunLifecycleEvent
  | AgentRunProgressEvent
  | AgentRunStreamEvent;

// src/session/events.ts：Task、来源与其他跨 Turn 的 Session 状态。
export type SessionEvent =
  | TaskEvent
  | SessionSourceEvent
  | SessionMetadataEvent
  | AgentRunSummaryEvent;

// src/events/index.ts：只组合各业务包已经定义的应用级事件。
export type AppEvent =
  | CharacterEvent
  | ProviderHealthEvent
  | MemoryBackgroundEvent
  | KnowledgeJobEvent
  | SystemWarningEvent;
```

`src/events` 与 `src/ids` 一样是严格叶面规则下的基础边界，但职责相反：
`ids` 只声明跨域稳定身份，`events` 只组合跨端通道可解码的事件联合。任何事件字段、
状态、错误码和业务对象都禁止在 `src/events` 定义，必须回到生产该事件的业务包。

所有 `TurnEvent` 必须携带 `sessionId + turnId`；涉及具体调用时继续携带真实 `llmCallId/toolCallId/promptId/agentRunId`。Task 等事件可以显式使用 `causedByTurnId` 表达因果来源，但不能因此伪装成 Turn 事件。SSE cursor、重放序号和连接状态属于传输层，不写进业务事件。

传输通道同样使用窄类型：`TurnEventStore` 只接受 `TurnEvent`；Session 事件通道只接受 `SessionEvent`；`AppEventBus` 只接受 `AppEvent`。AgentRun 的低频摘要可以投影到父 Turn 或 Session，高频 transcript 按 `agentRunId` 独立订阅。迁移期 `EmaStreamEvent` 只能作为带弃用标记的旧消费者兼容别名，任何新接口不得继续扩大它，完成消费者迁移后删除。

Desktop、CLI、Web 与集成渠道只从业务模块的 `protocol` 入口导入纯数据类型或运行时 Schema，不导入 Adapter、Repo、Node SDK 和业务实现。跨 HTTP/SSE 边界的关键输入最终需要 TypeBox/Zod 等运行时验证；只有 TypeScript interface 不能证明外部数据安全。

## 8. 前端目标

### 8.1 Chat/Work

- 顶层 Mode 控件改成 Chat/Work；
- 切换只修改下一 Turn 的 `executionProfile`，不改写正在运行的 Turn；
- 同 Session 可切换，不创建新 Session；
- UI 依据后端返回的 Profile Snapshot 展示，不依赖全局 Mode；
- NarrativePolicy 放在 Chat 二级菜单，但底层按 Session 保存，Work 也可以读取同一设置；
- Narrative 专用召回块继续使用现有 timeline 事件；
- Work 才显示完整 AgentRuns/工具工作区；Chat 只展示实际发生的只读工具。

### 8.2 事件与持久化

Turn 事件至少携带：

```ts
interface TurnExecutionSnapshot {
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  promptRevision: string;
  toolManifestRevision: string;
  characterId: string;
}
```

这些字段必须显式存在，不能放进 `meta_json` 让前端猜。

## 9. 现有未完成问题的收口位置

### 9.1 发布前必须完成或作出明确发布决策

- [ ] F-001：Windows 本机完整安装包与四平台 CI 原生验收；当前发布脚本/workflow 还有未提交文件；
- [ ] F-002：Cubism Runtime 与角色模型再分发许可、私有制品 release 验收；
- [ ] F-049：Windows/macOS 签名与公证。Updater/回滚可单独决定是否进入首发；
- [ ] F-021：用户 Live2D 资源不能继续返回不可消费的绝对路径，需要授权资源协议；
- [ ] Character Card 测试导入不存在的 `src/seed.js`，当前 0 tests；
- [ ] B-071：图片自动内联仍使用 `statSync/readFileSync`；普通附件路径进入 Prompt 的隐私与可用性也要随 Tool 读取契约收口；
- [ ] B-091：Core 路由与 `AppBindings` Service Locator 随本 RFC 分批收敛。

### 9.2 本次统一 Runtime 直接覆盖

- [ ] 删除 `ConversationEngine`，迁移为 TurnExecutor + AgentLoop + ChatProfile；
- [ ] `TurnMode` 从 `chat/narrative/agent` 演进为 `executionProfile + narrativePolicy`；
- [ ] Narrative Hook 改为 NarrativeSearchTool + NarrativeRecallFacade；
- [ ] Prompt Mode block 改为显式 Slot；
- [x] Compaction 从 Memory 移入 Context；
- [x] `agent-context` 拆分并删除；
- [x] 根 AgentTask 投影删除，子 Agent 迁移为 AgentRun；
- [ ] B-065：Card/Session 等用户动作在各业务 Facade 上统一 ActionResult，不新建传统 application 层；
- [ ] B-066：TurnRequest 等重复 DTO 收敛到业务所有者的 `protocol` 入口 + mapper，不再进入 contracts；
- [ ] B-073：Semantic chunking 重复 embedding 作为独立性能项，不与 Runtime 重构混改；
- [ ] Marketplace seed version/reconciliation 与 Adapter Schema；
- [ ] 文件生命周期治理：prepare/commit/rollback/orphan sweep 的统一边界。

### 9.3 明确留到 V1.5 的增强

- [ ] Fork 后复制 TTS 音频行与物理文件；
- [ ] 用户 Live2D 模型上传、多角色、舞台 scale/position/FPS 设置；
- [ ] Qwen TTS 真正逐帧 PCM 播放和 MIME/采样率/声道前端契约；
- [ ] Windows Restricted Token/AppContainer/独立 Sandbox Worker；
- [ ] Runtime 受限自动重启、指数退避、jitter、crash budget；
- [ ] 完整 Plan Mode；
- [ ] MCP 解码前 transport frame/stdio 行硬限制；
- [ ] ZIP v2/JSONL/流式压缩/hash manifest/分卷；
- [ ] PDF 纯矢量图表识别；
- [ ] 跨领域 Job Runtime；
- [ ] Hook Settings、外部 Session/Plugin/Config Hook；
- [ ] Skill 多 Root 与跨盘 relocate；
- [ ] Provider 原生 CountTokens；
- [ ] 定价、费用仪表盘与可信 STT 时长；
- [ ] i18n、自定义快捷键、Tool Auto-review/按需解释；
- [ ] 动态主题 hue 与其他纯视觉增强。

## 10. 迁移批次

### C0～C5：已完成的 contracts 拆除线

中央 Contracts 已删除。以下内容只记录迁移过程和当时的验证事实，不再指导下一阶段施工；残余事件、Wire 或 Store 边界问题按各自业务模块处理。

#### C0：冻结中央包

1. 冻结并最终删除中央 Contracts；
2. ID、事件、Wire、Usage 和错误由业务模块定义；
3. 生产代码中的 `@ema-agent/contracts` 引用已经清零。

#### C1：Message + LLM + Context

1. `LlmMessage` 迁为 LLM 内部 `Message`；
2. Session Message 与模型 Message 分离；
3. `historyToLlmMessages` 从 Session 迁入 Context 的 `messageBuilder`；
4. Context 明确历史、本轮、Tool 生成内容来源；
5. LLM 完成统一 `prepare()`、媒体能力门禁与轻量调用快照；
6. LLM 不再依赖 contracts 的 Message、Block、Usage 和 ID。

当前进度（2026-07-23）：

- [x] `src/llm/message.ts` 成为模型 Message 与模型可见 Block 的所有者；
- [x] `src/llm/ids.ts` 拥有 `LlmCallId`，`src/llm/usage.ts` 拥有 `LlmTokenUsage`；
- [x] 新建 `src/usage`，承接跨 LLM/Vision/Embed/Rerank/STT/TTS 的 Usage 写入端口；
- [x] 新建 `src/context/messageBuilder.ts`，Session 不再拥有 `historyToLlmMessages`；
- [x] Agent 与 Conversation 统一通过 Context 投影历史消息；
- [x] LLM 生产代码对 `@ema-agent/contracts` 引用归零，核心源码文件名改为 `lowerCamelCase`；
- [x] 删除 `LlmMessage = Message` 迁移别名，LLM 源码与测试统一使用 `Message`；
- [x] 删除已损坏且重复实现旧 Agent 编排的 `live-agent-business.test.ts`，同时删除硬编码凭据与 `describe.only` 的旧阿里云 live 测试；
- [x] 保留通过环境变量显式启用的 DeepSeek live 测试，用于验证真实 Provider、流式事件、工具调用和协议差异；
- [x] Vision/Embed/Rerank/STT/TTS、Core 与 Storage 已切到 `@ema-agent/usage`，contracts 中旧 Usage 定义已删除。
- [x] `ModelsDevCatalog` 与 `ModelCapabilitySnapshot` 迁入 `src/providers/catalog`，LLM 只依赖注入的 `ModelCapabilityResolver`；
- [x] Prompt 前缀 Hash 与 Tool Manifest 稳定化迁入 `src/context/promptPrefix.ts`，LLM 不再制定 KV Cache 策略；
- [x] 历史媒体降级与本轮附件门禁迁入 Context，LLM 只保留 Adapter 前覆盖 Hook/Tool 内容的最终能力校验；
- [x] 将 `packages/memory/src/compact` 迁入 Context，并让 Agent/Conversation 通过统一 Context 边界执行预算与压缩；采用 ToolResult 落盘 → Micro → Macro → Reactive 的 V1 渐进策略，并加入三次失败熔断。
- [x] Provider Runtime Entry 改为配置与 Adapter 共用冻结快照；热刷新只替换真实变化的 Provider，并移除 LLM 注册顺序兜底，Turn 与后台业务必须使用显式模型选择或专属 Binding。
- [x] 模型能力查询从 `LanguageModel` 公共接口迁回 Provider Resolver，Agent、Conversation 与 Core 显式依赖能力边界；LLM 仅在发送前执行最终门禁。Probe 同步补齐明确终态、十秒超时、调用方取消和安全错误码。
- [x] 删除混合 `packages/ebd-client`，拆为 `src/embed` 与 `src/rerank` 两个执行模块；Core、Memory 与 Knowledge Base 分别依赖实际使用的能力，不再共享注册顺序或默认模型兜底。
- [x] `packages/vision` 迁入 `src/vision`；`VisionRuntime` 使用原子 Provider Entry，并将并发队列、请求校验和取消作用域从旧 Router 拆开。错误字段显式化，Gemini 不再静默丢弃不支持的 HTTP 图片。
- [x] `packages/tts` 与 `packages/stt` 迁入 `src/tts`、`src/stt`；两者改用原子 Provider Entry，删除按插入顺序选择 Provider 的接口，并为 Probe 增加取消、超时和稳定错误码。
- [x] `packages/storage` 以保持行为的方式迁入 `src/storage`；包名、Schema、Migration 顺序和 Repository 公共 API 不变，通用 SQLite 基础设施留待边界稳定后再评估。

#### C2：Turn + SSE Event

1. 各业务模块迁出自己的事件；
2. 事件按 AgentLoop、Turn、AgentRun、Session 与 App 五个生命周期范围组合，不重新声明业务字段；
3. Turn Request/Response/Stats 与执行快照迁入 Turn；
4. Core SSE 与 Desktop UI 切换到业务 `protocol` 入口。

当前进度（2026-07-21）：

- [x] 新建 `src/turn` 与 `@ema-agent/turn` 公共入口，承接 Turn Request/Response/Stats、输入校验和迁移期 `EmaStreamEvent`；
- [x] Core、Desktop UI、Agent、Conversation、Tool、Context、Memory、TTS 等消费者不再从 `contracts` 读取 Turn/SSE 类型；
- [x] `contracts` 删除 `turns.ts`、`events.ts` 导出，并移除已无用途的 Provider 依赖；
- [x] Provider、Permission 与 Emotion 已拥有各自的客户端事件类型；现有 Turn 聚合仅是迁移期状态，不再作为目标架构；
- [ ] Knowledge Base 与 Character 事件迁移前先解除 `Knowledge/Character → Storage → Turn` 循环；Storage 不应为了持久化 AskUser JSON 反向依赖整个 Turn 协议；
- [ ] 将当前聚合事件按 Tool、Context、Memory、Knowledge、TTS、Agent 等真实业务所有者继续拆分，再分别组合为 `AgentLoopEvent/TurnEvent/AgentRunEvent/SessionEvent/AppEvent`；
- [ ] 将 `TurnEventStore`、Session 事件通道和 `AppEventBus` 改为窄类型，迁移消费者后删除 `EmaStreamEvent`；
- [ ] 把 Turn 执行快照迁入 Turn，并为关键 HTTP/SSE 输入补运行时 Schema。

#### C3：Session + Wire

1. Session、Message、Fork、Search、Attachment 和 Dashboard Wire 按所有者拆分；
2. Storage Row、Session Domain、前端 Wire 不再共用一个大联合；
3. 前端删除手写重复 DTO。

#### C4：Tool/Permission/Agent/Memory/KB 等

1. 按 7.4 所有权表迁移剩余类型；
2. 拆除中央 IDs 与 ErrorCode；
3. 关键 HTTP/SSE 输入补运行时 Schema。

#### C5：收口中央入口（已完成）

1. 业务专属类型已经迁回对应模块；
2. 中央 `src/contracts` 与旧 `packages/contracts` 路径已经删除；
3. 后续不恢复兼容入口，跨端协议由真实业务所有者导出。

### R0：契约冻结与保护测试

1. 给现有 Chat、Narrative、Agent 各建立输入→SSE→落库金标准测试；
2. 修复 Character Card 0 tests；
3. 锁定 Prompt 顺序、Tool Manifest 顺序与 prefix hash；
4. 锁定 Session 内切换 Profile 时并发 Turn 不被改写；
5. 记录当前 release smoke，禁止后续路径移动破坏制品。

### R1：在业务所有者中增加协议，不切换引擎

1. Turn 与 Narrative 所有者分别增加 `ExecutionProfile/NarrativePolicy/TurnExecutionSnapshot`；
2. 旧 `TurnMode` 保持兼容映射；
3. Storage migration 增加显式列，不放 `meta_json`；
4. 前端可以读取新字段，但仍使用旧 Mode 执行。

### R2：Prompt Slot 与 Tool Manifest

1. 建 PromptAssembler/PromptSlot；
2. 将现有角色、Mode、Hook、Memory Prompt 逐槽迁移；
3. 建 global/session/turn prefix hash 测试；
4. 建 Chat/Work 两套稳定 Tool Snapshot；
5. 不在这一批移动目录。

### R3：Context/Compaction

1. 新建 ContextAssembler；
2. 搬出 `memory/src/compact`，保持函数与测试行为不变；
3. MemoryPlanner 不再暴露 `compact()`；
4. Agent/Conversation 都先接 ContextAssembler；
5. 工具结果清理从 `agent-context` 搬到 tools/results。

### R4：Narrative Tool

1. NarrativeRecallFacade 包住 route + 多 timeline 并行查询；
2. 新建稳定 ID 的 NarrativeSearchTool；
3. 保留现有 Narrative SSE 与专用前端 Block；
4. 实现 auto/always/off；
5. route 模型改为 Narrative 自有配置。

### R5：统一 TurnExecutor + AgentLoop

1. [已完成] 旧 AgentEngine 已迁入 `turnExecution/TurnExecutor` 并删除，不新增第三层包装；现有 `turnLoop` 已收口并改名为 AgentLoop；
2. ChatProfile 先迁入，最大迭代和 Tool allowlist 受限；
3. WorkProfile 迁入完整工具、权限和子 Agent；
4. 旧 ConversationEngine 变成短期适配器；
5. 金标准测试一致后删除 ConversationEngine 包。

### R6：AgentTask/AgentContext 退役与 Task 建立

1. Turn 成为唯一根生命周期（已完成）；
2. 子 Agent 迁移 AgentRun，Tool Journal 同时记录父 Turn 与可选 AgentRun（已完成）；
3. AskUser 与 Prompt Registry 脱离根 AgentTask（已完成）；
4. Tool journal 保留（已完成）；
5. 前端 `TaskPanel` 已迁移为 `AgentRunPanel`，旧 HTTP 兼容入口已删除；SSE 暂时只保留 `subagentId` 跨端字段名；
6. 真正的 `src/tasks`、TaskStore、依赖、活动 AgentRun 投影、Task 事件和根 Turn 四个 Task Tools 已完成；
7. 低频 Task Context、重启快照、备份恢复与独立前端 TaskList 已完成；
8. Data v17 已删除旧 AgentTask 表并迁移真实子执行，Data v18 建立独立 Task 表；两者不复用生命周期。

### R7：前端切换

1. UI 只显示 Chat/Work；
2. Chat 二级菜单提供 NarrativePolicy；
3. Session 内切换只影响下一 Turn；
4. 新旧 Session 数据兼容；
5. 补多 Session 并行、切换中发送、Narrative 部分失败和窗口重开测试。

### R8：根 src 与包合并

1. Provider 与 LLM 的迁移模式作为后续模板；
2. 只做机械 move，不改业务；
3. 每迁移一个产品模块就删除旧路径并检查 workspace dependency；
4. Core release deploy、native dependency smoke、无仓库启动全部通过；
5. 通用技术底座继续留在 packages，不为目录整齐强行搬迁；
6. 最后再处理 B-091 的 Route 与业务编排边界。

### R9：Agent 执行体系收口顺序

目录迁移和 Contracts 拆除已经结束，接下来按一个主要业务边界一批推进：

1. [x] Tool Result 归位到 `src/tools/results`，建立单结果上限和单消息聚合预算，并保持持久预览可重放；
2. [x] ToolExecution Journal 从 Tasks/Agent 收回 Tools，Storage 只保留 Store 实现；
3. [x] 解除 Sandbox 的错误依赖：把 `spawnProcess` 从 Tools 收回 Sandbox；合并重复的 `RunOptions/RunResult`；`CommandRunner` 不再持有 `PermissionEngine`，只接收已冻结的 Sandbox Policy；禁止无工作区时回退 `process.cwd()`；暂时禁用 detached 假后台；
4. [x] 删除 `ToolRegistry.dispatch()` 的 prepare->execute 旁路，冻结唯一执行入口；
5. [x] 将工具执行运行时迁入 `src/tools/execution` 为 `ToolExecutionRuntime`；Agent 通过窄生命周期端口接入 Hook，不让 Tools 反向依赖 Agent、Session 或 Hooks；
6. [x] 删除万能 `ToolExecutionContext/ToolExecutionScope/ToolInvocationContext`；Ema 集成层用单一 `BuiltinToolContext` 表达本次执行的身份与实际能力，每个 Tool 通过 `validateContext()` 投影窄 Context；执行器按调用覆盖 `toolCallId/signal/emit`，MCP 同样使用自己的结构化 Host Context，不再重复注入 per-Turn Bridge；
7. Tool Manifest 增加来源与稳定分区，再实现 Anthropic Tool Cache 断点并重新分配四个断点；
8. 按 7.2 的顺序逐组审查所有 Builtin Tool；
9. [已完成] 迁出 `agentContext` 剩余职责并删除该模块；
10. 收口 Task、AgentRun、ToolExecution、BackgroundProcess 四类身份与生命周期，并完成 V1 Task 全闭环；
11. Chat 接入统一 AgentLoop，删除 ConversationEngine；
12. [进行中] 根 Work Turn 的执行职责已迁入 `src/turnExecution/TurnExecutor`；下一刀收回 Turn 创建并建立 `TurnHandle`；
13. `apps/core` 退回 Route、SSE、认证、启动恢复和 Composition Root；
14. 最后对 Permission、Sandbox 做针对性收口和 Windows/macOS/Linux 验证。

这些步骤允许相邻批次共用已经稳定的端口，但不能把 Turn 统一、全仓 ID 改名、数据库 Schema 和前端 Profile 切换塞进同一批。

## 11. 下一阶段的实际边界

Tool Result、统一预算、ToolExecution Journal、执行运行时所有权迁移和 Tool Context 收窄已经完成。Registry 不再提供组合执行捷径：

1. [x] 删除 `ToolRegistry.dispatch()`，可信测试调用也显式使用 `prepare()` 与 `execute()`；
2. [x] 执行必须接收当前 Registry 生成的不可变 `PreparedToolCall`；
3. [x] `ToolExecutionRuntime` 统一承担并发栅栏、Hook 观察、Permission、Journal、结果预算和取消收口；
4. [x] AgentLoop 只启动执行批次、等待结果并决定是否继续下一轮，不建立第二个 Scheduler；
5. [x] 每次根 Agent/子 Agent 先按实际 `BuiltinToolContext` 装配模型可见 Manifest，再由同一 Manifest 建立 Policy；每个 Tool 的 `validateContext()` 在权限和副作用前完成窄投影，工具不可见与不可执行不再依赖两套手写白名单；
6. Tool Manifest 2C、Builtin Tool 2D 与 TurnExecutor 第一刀已完成；下一步建立 `TurnHandle`，再迁 Chat 并删除 ConversationEngine。

## 12. 完成标准

- 前端只有 Chat/Work，Session 内可切换；
- Chat/Work 都只通过 TurnExecutor + AgentLoop；
- Narrative 是 Tool + Facade，保留多周目 Route 与专用 UI；
- NarrativePolicy 三态可持久化且不会移除角色 Prompt；
- Prompt Slot 顺序可测试，Tool Manifest 稳定且权限不因缓存妥协；
- Memory 不再导出 Compaction；
- `agent-context` 与根 AgentTask 旧语义已经删除；`conversation` 必须在 TurnExecutor 迁移中按职责拆散，生产依赖、Workspace 配置和源码目录全部清零后删除；
- Turn 是唯一根生命周期，AgentRun 只表示子 Agent；
- V1 Task 使用独立 UUID/短序号、显式字段、SQLite 事务/CAS 和依赖关系，并由 TaskCreate/Get/List/Update、动态 Context 提醒及独立 TaskList 构成完整闭环；
- TodoWrite 不再注册，Task、AgentRun、BackgroundProcess、ToolExecution 与领域 Job 不共享 ID 或状态机；
- Core Route 只做协议适配，业务进入对应模块的稳定公开入口或 TurnExecutor；
- 中央 Contracts 路径归零，业务类型由各自模块拥有；
- Session Message、LLM Message、Provider SDK Message 三层可辨认且只在明确 mapper 中转换；
- Windows/macOS/Linux 的正式 Sidecar 制品仍能独立启动；
- 所有迁移都保留结构化 SSE，不向前端发送未解析日志字符串。
