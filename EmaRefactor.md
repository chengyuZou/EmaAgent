# EmaAgent 统一 Turn Runtime 与契约拆分 RFC

> 状态：设计中，不代表当前源码已经完成迁移  
> 日期：2026-07-21  
> 范围：后端统一引擎、业务契约拆分、Prompt 插槽、Context/Compaction、Narrative Tool、前端 Chat/Work，以及剩余发布前问题  
> Artifact：继续由 V1 Feature Gate 禁用，不进入本 RFC

## 1. 为什么现在要重构

Ema 当前已经具备 Turn、SSE、工具、权限、Sandbox、Memory、Narrative、Skill、MCP 和多模型能力，但这些能力仍被旧的三个 Mode 和大量细包切开：

- `ConversationEngine` 负责 `chat/narrative`，`AgentEngine` 负责 `agent`；
- `narrative` 本质上是多周目剧情 RAG，却被建模成顶层执行模式；
- `agent-context` 实际混合文件快照与工具结果，并不是完整的模型上下文系统；
- `agent-task` 同时表达根 Turn 投影、等待用户、子 Agent 与 transcript，和 Turn 状态重叠；
- Compaction 放在 Memory 包内，导致长期记忆与模型窗口治理互相污染；
- `apps/core` 直接依赖二十多个内部包，`AppBindings` 已接近 Service Locator；
- Prompt 没有稳定插槽与缓存边界，角色、Mode、MCP、Skill、工具变化容易破坏 KV Cache。
- `packages/contracts` 已混入模型内部消息、数据库持久化结构、前端 Wire、各业务事件、ID、Usage 与错误码，失去明确所有者；
- 同一个“Message”同时表达 Session 记录、模型输入和前端 DTO，导致历史转换、媒体降级和持久化展示互相渗透。

本轮目标不是换目录名字，而是先确定唯一运行语义，再做可验证迁移。

当前已经完成的地基：Provider 与 LLM 已迁入根 `src`；LLM 使用 `LanguageModel` 作为业务接口、`LanguageModelRuntime` 作为 Core 装配实现，并已建立 Provider 原子快照、`llmRequestPreparer`、明确流终态和连续 Block Index。第二轮又完成了 LLM 自有 `Message/ContentPart/AssistantBlock/LlmCallId/LlmTokenUsage`、跨模态 `usage` 写入端口和 Context `messageBuilder`；LLM 生产代码已不再依赖 `packages/contracts`。后续不能再按旧 `LlmRouter` 或 `packages/llm` 设计。

## 2. 已确定的产品语义

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

`off` 只关闭剧情数据库检索，不移除 Character Prompt。UI 应提示：角色基础设定仍保留，但可能缺少剧情细节或混淆周目。

### 2.2 统一引擎叫 TurnEngine

统一执行器不再叫 `ConversationEngine` 或 `AgentEngine`，而叫 `TurnEngine`：

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

- `auto`：向 TurnEngine 暴露 NarrativeSearch，由主模型按需调用；
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

- 内置通用 Tool 按稳定 ID 排序；
- Chat/Work 各维护一个 Profile Tool Snapshot，切换后使用对应缓存前缀；
- MCP 连接变化不能在正在执行的 Turn 中途改写工具表；
- Session 可冻结 MCP/Skill manifest generation，用户刷新后下一 Turn 生效；
- 不为追求一个缓存前缀而向 Chat 暴露 Work 写工具；
- 后续可引入 ToolSearch/Deferred Tool，缩短常驻 Schema，但不作为统一引擎第一批前置条件。

### 4.5 参考项目结论

- Claude Code 使用明确的静态/动态 System Prompt boundary，并把 Tool Schema 做 Session 级稳定缓存；
- Codex 将初始指令、历史、世界状态差分和 Compaction 分开处理；
- Ema 应学习其稳定前缀和显式边界，不复制巨型单文件。

## 5. Context 与 Compaction

### 5.1 删除 agent-context 包，不删除 Context 概念

`agent-context` 当前包含文件状态、工具结果等能力，名字和职责都不准确。目标是拆分后删除该包：

```text
原 agent-context
├─ FileStateStore      → tools/files 或 session-files
├─ ToolResultStore     → tools/results
├─ ToolResultCleaner   → tools/results 生命周期
└─ AgentContextSnapshot→ 新 ContextManager 的明确输入
```

新的 `context` 只表达“即将送进模型的上下文窗口”：

```text
context/
├─ context-manager.ts        历史版本、替换、回滚
├─ context-assembler.ts      Prompt Slot + messages + tool results
├─ normalization.ts          Tool call/result 配对、多模态兼容
├─ token-budget.ts           预算与可信 usage
├─ tool-result-policy.ts     截断、外置和摘要
└─ compaction/
   ├─ service.ts
   ├─ strategy.ts
   ├─ prompt.ts
   ├─ sanitize.ts
   └─ restore.ts
```

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
export interface ContextFacade {
  build(request: ContextBuildRequest): Promise<ModelContext>;
  compact(request: ContextCompactionRequest): Promise<ContextCompactionResult>;
}

export interface MemoryFacade {
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  scheduleExtraction(request: MemoryExtractionRequest): Promise<void>;
}
```

`ContextFacade` 可以调用 `MemoryFacade.recall()`，但不得 import Memory 内部 Repo、Runner 或 Prompt。

Codex 的 `ContextManager + compact`、AstrBot 的 `agent/context/manager + compressor` 都支持这一边界。

## 6. AgentTask 的去留与命名

当前 `agent-task` 尚未删除，Storage、Core、Agent、Desktop UI 仍有真实引用。不能直接删目录。

目标语义：

```text
Turn       用户发起的一轮交互，唯一根生命周期
ToolCall   一次工具执行
AgentRun   Work 模式创建的子 Agent 运行
DomainJob  KB/Vision/Embedding 等各领域后台任务
```

根 AgentTask 不再复制 Turn 的 running/completed/failed/cancelled 状态。迁移完成后：

- `AgentTurnLifecycleFacade` 退役，Turn 成为唯一根终态；
- `agent_tasks` 中的根投影迁移或删除；
- 子 Agent 数据迁移为 `agent_runs/agent_run_messages`，前端 `TaskPanel` 改成 `AgentRunsPanel`；
- AskUser 等待状态归 Turn + Prompt Registry，不依赖根 AgentTask CAS；
- Tool 副作用恢复继续由 `tool_executions` journal 承担；
- KB、Vision、Memory 不继承 AgentRun，也不强行塞进一个通用 Task 表。

在迁移前必须保留现有 CAS、恢复和 transcript 测试，避免“删了包但把断电恢复也删了”。

## 7. 目标代码结构

### 7.1 Agent-native 业务结构

```text
src/
├─ agent/
│  ├─ turnEngine.ts             唯一模型循环入口
│  ├─ loop/
│  ├─ profiles/
│  │  ├─ chatProfile.ts
│  │  └─ workProfile.ts
│  ├─ recovery/
│  └─ runs/                     子 Agent 的 AgentRun，不放后台 Job
├─ turn/
│  ├─ ids.ts
│  ├─ protocol.ts               Turn 命令、响应和执行快照
│  ├─ streamEvents.ts           组合各模块公开事件
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
│  ├─ events.ts
│  └─ protocol.ts
├─ permission/
├─ hook/
├─ session/
│  ├─ ids.ts
│  ├─ message.ts                 持久化 Session Message
│  ├─ protocol.ts               前端 Session/Message Wire
│  └─ ownership.ts
├─ narrative/
├─ memory/
├─ knowledgeBase/
├─ character/
├─ attachment/
├─ skill/
├─ mcp/
├─ providers/
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
├─ sandbox/
├─ system/
├─ credential/
├─ ui/
└─ live2d-react/
```

这棵树按 Agent 的真实执行路径命名，而不是按传统 DDD 分层：开发者从 `agent/TurnEngine` 出发，沿 `context → prompts → tools → permissions → events` 就能读完一次 Turn；Narrative、Memory、Knowledge、Character 等产品能力直接是一等目录，不藏进 `capabilities`；Desktop、CLI、Web、QQ、微信只在 `channels` 提供输入输出适配，不能各自复制 Agent 编排。

根 `src` 放 Ema 产品主体；`apps/core` 只保留 Node Sidecar 入口、HTTP/SSE、认证与装配；`packages` 保留确有跨应用复用、平台隔离、独立发布或独立测试价值的技术底座。产品模块即使用独立 `package.json` 参与 TypeScript/Turbo 构建，也仍属于根 `src`，不因此成为公共库。

目录命名约束：

1. 顶层名称必须能对应 Agent 流水线或用户能理解的产品能力；
2. 不建立 `application/domain/services/managers/common/utils` 等容易变成杂物箱的顶层目录；
3. `context` 只指模型上下文，不指 React Context、文件缓存或任意“上下文对象”；
4. `agent/runs` 只保存子 Agent Run，KB/Vision/Memory 后台工作仍使用本领域 Job；
5. 每个业务目录提供稳定公开边界，名称按职责使用 `LanguageModel`、Runtime、Client、Registry、Store、函数或确有协调职责的 Facade，不强制增加 `XxxFacade`；
6. `channels` 只能把平台输入规范化为 Turn、消费 `EmaStreamEvent`，不能拥有独立聊天引擎。

### 7.2 命名与文件规范

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

### 7.3 根 src 迁移的验证规则

Provider 与 LLM 已证明产品模块可以位于根 `src`，同时保留内部 workspace 包名作为编译边界。后续迁移继续遵守：

1. 先保持行为做纯目录迁移，再单独修改业务；
2. 每迁一个模块都检查 Workspace、lockfile、Turbo 依赖图与旧路径残留；
3. `apps/core/dist` 不得产生依赖仓库源码路径的越界相对 import；
4. `pnpm deploy --prod` 必须收集根 `src` 模块及 native dependency；
5. release runtime 必须在没有 Git 仓库、Node 和 Python 开发环境时启动；
6. 不在同一批同时执行全仓路径移动、数据库 Schema 重构和 TurnEngine 语义切换。

### 7.4 删除 packages/contracts

`packages/contracts` 不保留、不改名为新的中央 `protocol` 包。真正跨进程的协议仍必须有单一事实来源，但由业务所有者定义，再由 Turn 组合。

#### 类型所有权

| 当前 contracts 内容 | 目标所有者 |
|---|---|
| `LlmMessage`、模型输入 Part、模型输出 Block、`LlmTokenUsage`、`LlmCallId` | LLM |
| Session `Message`、`MessageKind`、持久化 Blocks、`SessionId/MessageId/BranchId` | Session |
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

每个 ID 由对应模块声明品牌和转换函数，不新建全局 `ids` 包。每个模块在自己的 `errors.ts` 导出稳定错误码；Turn 只组合一次 Turn 可能暴露给客户端的错误联合。

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

各业务模块定义自己的公开事件，`turn/streamEvents.ts` 只组合：

```ts
export type EmaStreamEvent =
  | TurnEvent
  | LlmEvent
  | ToolEvent
  | PermissionEvent
  | NarrativeEvent
  | MemoryEvent
  | KnowledgeBaseEvent
  | AgentEvent
  | TtsEvent
  | EmotionEvent
  | HookEvent
  | ProviderEvent
  | SystemEvent;
```

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

- [ ] 删除 `ConversationEngine`，迁移为 TurnEngine + ChatProfile；
- [ ] `TurnMode` 从 `chat/narrative/agent` 演进为 `executionProfile + narrativePolicy`；
- [ ] Narrative Hook 改为 NarrativeSearchTool + NarrativeRecallFacade；
- [ ] Prompt Mode block 改为显式 Slot；
- [x] Compaction 从 Memory 移入 Context；
- [ ] `agent-context` 拆分并删除；
- [ ] 根 AgentTask 投影删除，子 Agent 迁移为 AgentRun；
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

### C0～C5：contracts 拆除线

contracts 拆除与 Runtime 重构并行推进，但每批只迁一个明确所有权切片：

#### C0：冻结中央包

1. `packages/contracts` 从现在起只减不增；
2. 新 ID、事件、Wire、Usage 和错误直接由业务模块定义；
3. 建立 `rg "@ema-agent/contracts"` 引用基线与模块归属清单。

#### C1：Message + LLM + Context

1. `LlmMessage` 迁为 LLM 内部 `Message`；
2. Session Message 与模型 Message 分离；
3. `historyToLlmMessages` 从 Session 迁入 Context 的 `messageBuilder`；
4. Context 明确历史、本轮、Tool 生成内容来源；
5. LLM 完成统一 `prepare()`、媒体能力门禁与轻量调用快照；
6. LLM 不再依赖 contracts 的 Message、Block、Usage 和 ID。

当前进度（2026-07-21）：

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

#### C2：Turn + SSE Event

1. 各业务模块迁出自己的事件；
2. Turn 组合 `EmaStreamEvent`，不重新声明业务字段；
3. Turn Request/Response/Stats 与执行快照迁入 Turn；
4. Core SSE 与 Desktop UI 切换到业务 `protocol` 入口。

#### C3：Session + Wire

1. Session、Message、Fork、Search、Attachment 和 Dashboard Wire 按所有者拆分；
2. Storage Row、Session Domain、前端 Wire 不再共用一个大联合；
3. 前端删除手写重复 DTO。

#### C4：Tool/Permission/Agent/Memory/KB 等

1. 按 7.4 所有权表迁移剩余类型；
2. 拆除中央 IDs 与 ErrorCode；
3. 关键 HTTP/SSE 输入补运行时 Schema。

#### C5：删除包

1. 生产、测试与脚本中的 `@ema-agent/contracts` 引用归零；
2. 删除 workspace dependency、tsconfig path 与 lockfile link；
3. 删除 `packages/contracts`；
4. 运行全仓 build/typecheck/test、Core/Desktop 联调与 release smoke。

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

1. 新建 ContextManager；
2. 搬出 `memory/src/compact`，保持函数与测试行为不变；
3. MemoryPlanner 不再暴露 `compact()`；
4. Agent/Conversation 都先接 ContextFacade；
5. 工具结果清理从 `agent-context` 搬到 tools/results。

### R4：Narrative Tool

1. NarrativeRecallFacade 包住 route + 多 timeline 并行查询；
2. 新建稳定 ID 的 NarrativeSearchTool；
3. 保留现有 Narrative SSE 与专用前端 Block；
4. 实现 auto/always/off；
5. route 模型改为 Narrative 自有配置。

### R5：统一 TurnEngine

1. 抽取 AgentEngine 的循环为 TurnEngine；
2. ChatProfile 先迁入，最大迭代和 Tool allowlist 受限；
3. WorkProfile 迁入完整工具、权限和子 Agent；
4. 旧 ConversationEngine 变成短期适配器；
5. 金标准测试一致后删除 ConversationEngine 包。

### R6：AgentTask/AgentContext 退役

1. Turn 成为唯一根生命周期；
2. 子 Agent 迁移 AgentRun；
3. AskUser 与 Prompt Registry 脱离根 AgentTask；
4. Tool journal 保留；
5. 前端 TaskPanel 迁移 AgentRunsPanel；
6. 删除包前用 `rg` 保证生产引用为零，再删除数据库旧结构或写兼容迁移。

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

## 11. 下一阶段的实际边界

下一阶段继续收口 C1，再进入 C2；不先全仓删除 contracts，也不继续向其中增加兼容类型：

1. 保持 contracts 只减不增，并持续检查 LLM 生产代码零引用；
2. 真实 Provider 冒烟测试必须由环境变量显式启用，禁止硬编码凭据和 `describe.only`；
3. 保持所有模型能力只从 `src/usage` 读取跨模态 Usage 写入协议；
4. 保持现有 SSE 与数据库行为，用测试证明迁移前后一致；
5. C1 收口后进入 C2 事件拆分；
6. 不在 C1 同时切换 Chat/Work、删除 ConversationEngine 或重做数据库 Message Schema。

## 12. 完成标准

- 前端只有 Chat/Work，Session 内可切换；
- Chat/Work 都只通过 TurnEngine；
- Narrative 是 Tool + Facade，保留多周目 Route 与专用 UI；
- NarrativePolicy 三态可持久化且不会移除角色 Prompt；
- Prompt Slot 顺序可测试，Tool Manifest 稳定且权限不因缓存妥协；
- Memory 不再导出 Compaction；
- `agent-context`、`conversation`、根 AgentTask 生产依赖清零后再删除；
- Turn 是唯一根生命周期，AgentRun 只表示子 Agent；
- Core Route 只做协议适配，业务进入对应模块的稳定公开入口或 TurnEngine；
- `packages/contracts` 引用归零并删除，各模块 protocol 入口成为唯一事实来源；
- Session Message、LLM Message、Provider SDK Message 三层可辨认且只在明确 mapper 中转换；
- Windows/macOS/Linux 的正式 Sidecar 制品仍能独立启动；
- 所有迁移都保留结构化 SSE，不向前端发送未解析日志字符串。
