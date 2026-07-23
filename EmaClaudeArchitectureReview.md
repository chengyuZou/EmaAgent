# EmaAgent 与 Claude Code 架构逐章对照

> 状态：第一轮全量审阅完成，已按 `how-claude-code-works/docs` 的章节顺序逐篇核对
> 日期：2026-07-21  
> 目的：区分可直接学习的工业边界、Ema 当前已经具备的能力、真实缺口，以及 V1 不应照搬的功能  
> 证据优先级：Ema 实际源码与测试 > `EmaRefactor.md` 目标设计 > Claude Code 源码快照 > 逆向文档中的推断

## 阅读方法与结论标记

每章固定回答五个问题：

1. Claude 解决的业务问题是什么；
2. Ema 当前由哪些源码承担；
3. 两者的真实 Diff；
4. 重构时应该拆到哪里；
5. 它与前面章节通过什么接口连接。

结论使用以下标记：

- **V1 必做**：当前产品主链路或发布安全边界；
- **V1 收口**：已有实现需要统一或去耦，不扩建新产品能力；
- **V1.5 候选**：接口可预留，但现在不建立空包、空表或半成品 UI；
- **不照搬**：Claude 的 CLI、编码或云端业务专属设计，不适合直接复制。

本轮覆盖 `01-overview.md` 至 `21-background-fleet.md`，并用 `quick-start.md`、`reference.md` 做最终交叉校验。后续讨论若改变产品决策，应更新对应章节与 `EmaRefactor.md`，不再另建第二份架构真相源。

---

## 01 概述：Agent-first 与统一执行核心

### Claude 的业务与架构

Claude Code 把自身定义为受控工具循环 Agent，而不是聊天接口或代码补全器。它的稳定核心是一个不依赖 UI 的 `query()` 异步生成器；REPL、`-p` 和 SDK 等不同入口最终都驱动同一个循环。循环编排模型调用、上下文压缩、工具执行与恢复，UI 只消费流式事件。启动阶段又把关键路径、延迟初始化和重依赖加载明确分开。

### Ema 当前事实

Ema 已经具备与这条主链大部分对应的模块：

```text
Desktop / apps/core route
        ↓
ConversationEngine 或 AgentEngine
        ↓
LLM + Context + Tools + Permission + Hook
        ↓
AsyncIterable<EmaStreamEvent>
```

已有优势：

- `Turn`、结构化 SSE 和 `AsyncIterable<EmaStreamEvent>` 已建立；
- Provider 与各模型执行面已经分离，低层模型调用不感知 Session；
- Permission 与 Sandbox 已物理分层；
- Desktop、TS Sidecar、Python Bridge 的部署边界比单进程 CLI 更清楚；
- 产品从一开始就有桌面 UI、角色、Memory、KB 和 Narrative，不必复制终端 REPL。

当前主要偏差：

- `ConversationEngine` 与 `AgentEngine` 仍是两套循环，Chat/Work 尚未汇聚到唯一执行核心；
- `apps/core` 的 route/wiring 仍承载部分业务编排，入口层边界不稳定；
- 模块正在从 `packages` 搬往根 `src`，调用方仍可能穿透旧包内部；
- 启动、自检、依赖 readiness 与延迟加载尚未形成一条可审计的 Composition Root 流程；
- 前端、Core 与 Agent 之间仍残留旧 `mode`、`AgentTask` 和多套消息类型。

### Diff 判断

1. **V1 必做：统一 TurnEngine。** Chat 与 Work 必须共享同一个循环，只通过 Profile 控制迭代预算和工具能力。不能继续维护第三套 Engine。
2. **V1 必做：核心循环不依赖入口。** Desktop、未来 CLI/Web/QQ/微信只负责把输入规范化为 Turn，并消费事件；不得复制业务循环。
3. **V1 收口：Core 退回 Sidecar BFF。** Route 只解析、校验、认证和转换 SSE，业务编排进入根 `src` 的产品模块。
4. **V1 收口：建立明确启动阶段。** Tauri 管 Sidecar 生命周期；Core Composition Root 负责数据库迁移、凭据、Provider Runtime、Tool Registry 和 Bridge readiness；非关键目录扫描、Catalog 刷新和遥测延迟执行。
5. **不照搬：集中式巨型全局 State。** Ema 多 Session 并行且有桌面多窗口，不应复制 Claude 单会话 CLI 的 150+ getter/setter 全局状态。Session/Turn 状态必须显式按 ID 隔离。
6. **不照搬：Bun 编译期 Feature Flag。** Ema 使用 NodeNext/Tauri/Turbo，V1 继续使用明确 Feature Gate 与构建入口，不引入第二套 bundler 宏体系。

### 建议拆分

```text
src/agent/
├─ turnEngine.ts          唯一模型工具循环
├─ loop/                  单次迭代与状态转换
├─ profiles/              Chat/Work 能力策略
├─ recovery/              API、上下文和工具恢复
└─ runs/                  仅 Agent/Subagent 实际运行

src/turn/                 Turn 命令、身份、终态与组合事件
src/context/              发给模型的窗口和压缩
src/tools/                工具准备与执行
apps/core/                HTTP/SSE/认证/装配
```

### 与后续章节的接口

- 第 2 章应具体定义 `TurnEngine` 与单次循环状态，不能重新发明会话引擎；
- 第 3 章的 Context 只向循环提供模型请求视图，不拥有 Session；
- 第 4、11 章的 Tool/Permission 通过不可变 PreparedToolCall 接入循环；
- 第 12 章前端只能消费事件和发送命令；
- 第 15、21 章的 Task、AgentRun、Job 和后台 Session 不能重新混进 Turn 根生命周期。

### Codex Realtime 复核与 Ema 的长期边界

Codex App Server 同样使用 `Thread -> Turn -> Item/Event`，并把实时语音另建为 thread-scoped Realtime Session。实时连接可以通过 WebSocket/WebRTC 持续追加音频、文本和可朗读输出，也可以把语义结果 handoff 给普通 Agent Turn；它没有把整段实时连接伪装成一个永不结束的 Turn。

Ema 采用相同的生命周期分离，但保持自己的产品语言：现有 Session 对应长期会话容器，Turn 对应一次有界决策，未来 RealtimeSession/LiveSession 对应长连接媒体活动。屏幕感知、摄像头、微信消息、主动发言和直播都通过明确来源产生观察或触发，只有需要模型决策时才创建 Turn。Chat/Work 仍是执行 Profile，不因新增输入渠道而继续膨胀 Mode。

V1 只实现 `userMessage` 触发；未来来源只写入设计，不创建空 Runtime。非用户输入一律视为无授权数据，即使它来自另一个 Agent、网页、屏幕文字或外部聊天渠道，也不能批准文件写入、Shell、发送消息或凭据访问。

---

## 02 Agent Loop：会话外壳与循环内核

### Claude 的业务与架构

Claude 将会话级 `QueryEngine` 与循环级 `query()` 分开。前者处理用户输入、持久化、累计 Usage、预算和最终结果；后者只维护一次模型工具循环的状态，在每次调用前压缩上下文，流式接收模型输出，并在完整 `tool_use` block 出现后立即启动可并发工具。循环以显式 Continue/Terminal 转移处理正常下一轮、上下文过长、输出截断、Hook 停止与用户中断。

### Ema 当前事实

`packages/agent/src/loop.ts` 已经具备不少工业级地基：

- `while (true)` 模型工具循环和显式 `LoopState`；
- 每次 LLM 调用前执行 Context Compaction；
- `tool_use_complete` 到达时立即 `executor.addTool()`，不是等流结束后才执行；
- 并发安全 Tool 可并行，询问用户的 Tool 会让循环进入内存态 `waiting_user`；
- Context Window 过长只做一次 reactive compact，且不会重复执行有副作用的 beforeLlm Hook；
- `max_tokens` 自动续写一次；
- Turn Budget、Permission denial loop breaker 和最大迭代断路器已存在。

真正的问题在循环外层：

- `packages/agent/src/engine.ts` 与 `packages/conversation/src/engine.ts` 分别包装 Work 和 Chat/Narrative；
- `apps/core/src/orchestrator/orchestrator.ts` 再在两者之上选择 Engine、组装 Context、合并 TTS/协调事件并推进终态；
- 根 Turn 终态又通过 `AgentTurnLifecycleFacade` 与旧 AgentTask 投影耦合；
- Chat 的单轮流式路径与 Agent 的多轮状态机拥有重复的 Hook、持久化、媒体降级和错误处理。

### Diff 判断

1. **V1 收口：保留现有 `agentLoop`，不要重写成熟部分。** 流式工具预执行、响应式压缩、Usage delta 和断路器已经与 Claude 的关键思路对齐。
2. **V1 必做：建立双层但不是双模式的执行结构。** 外层 `TurnRuntime` 管 Turn 生命周期和持久化，内层 `TurnLoop` 管模型与工具迭代；Chat/Work 只提供 Profile，不再各有 Engine。
3. **V1 必做：所有终止必须有明确原因。** Provider 自然断流、Tool 结果缺失、Hook abort、用户取消和预算耗尽不能统一伪装成成功 `done`。
4. **V1 收口：错误恢复归循环所有。** Route、Desktop 和 Provider Adapter 不自行补轮次；Context 过长、输出截断、Permission denial 循环由 `TurnLoop` 统一决定是否继续。
5. **V1 收口：根 Turn 不再投影成 AgentTask。** AskUser 的 `waiting_user` 可以保留为当前循环内存 phase，但持久化身份属于 Turn + Prompt Registry，不属于 Task 或 AgentRun。
6. **V1.5 候选：完整错误 withholding。** Claude 会暂缓向模型暴露某些并行兄弟错误，Ema 当前先保证 tool_use/result 配对与一致取消；更复杂的错误扣留策略待真实并行 Tool 反馈后再做。

### 建议拆分与接口

```text
TurnRuntime.run(command): AsyncIterable<EmaStreamEvent>
  ├─ TurnStore.start/complete/fail/abort
  ├─ ContextAssembler.build
  ├─ TurnLoop.run
  └─ Hook/Emotion/TTS 事件组合

TurnLoop.run(input): AsyncIterable<TurnLoopEvent>
  ├─ LanguageModel.stream
  ├─ ToolExecutor
  ├─ ContextCompactor
  └─ TurnBudget
```

`TurnRuntime` 是产品入口，不放在 `apps/core`；`apps/core` 只把 HTTP command 交给它并编码 SSE。`TurnLoop` 不写 Session Repo，不知道 Desktop，也不直接管理后台 AgentRun。

### 与第 01 章复核

第 01 章提出“所有入口汇聚到一个执行核心”，第 02 章将其细化为 `TurnRuntime + TurnLoop`，并不意味着再创造两个业务 Engine：两层分别解决生命周期和迭代，Chat/Work 都走同一实例组合。现有 `Orchestrator + AgentEngine + ConversationEngine` 三层应收敛，而不是整体改名后保留。

---

## 03 Context Engineering：模型可见窗口、压缩与缓存稳定性

### Claude 的业务与架构

Claude 把 Context 当作“下一次模型请求看到的投影视图”，而不是 Session 数据、长期记忆或某个万能状态对象。它的主要机制可以分成五层：

1. 组装稳定的 System、Tool、用户上下文和历史消息前缀；
2. 规范化消息角色、`tool_use/tool_result` 配对及系统提醒位置；
3. 从零成本清理、工具结果裁剪、Microcompact、Context Collapse 逐步升级到 Autocompact；
4. Prompt-Too-Long 时只进行一次 Reactive Compact 并重试；
5. 通过缓存断点、会话级锁存和缓存断裂诊断保护 Provider KV Cache。

Claude 还使用 `<system-reminder>` 把系统注入内容放入消息流，并在模型生成期间预取相关记忆。这里的关键思想不是 XML 本身，而是“系统生成的上下文必须有明确身份、插入位置和生命周期”。

### Ema 当前事实

`src/context` 已经不是空迁移目录，现有实现包括：

- `messageBuilder.ts`：把持久化 Message 投影为模型可见 Message，并移除 UI 字段、thinking 和不应重放的块；
- `messageCompatibility.ts`：历史媒体不兼容时生成只读替代视图，本轮新媒体不支持或能力未知时拒绝发送；
- `promptPrefix.ts`：规范化 Tool Schema，并按显式 `cacheBreakpoint` 计算稳定前缀指纹；
- `ContextCompactor`：按模型窗口、输出预留和 buffer 计算阈值，依次执行 Micro、Macro、Restore，并在连续失败后按 Session 熔断；
- `safeCut.ts`：避免从未配对的 Tool 交互中间切断；
- `postCompactionRestore.ts`：压缩后恢复 Session Note 与最近文件状态；
- `packages/agent/src/loop.ts`：每次模型调用前主动压缩，PTL 时最多执行一次反应式压缩；重放时明确移除 thinking；
- `packages/agent-context`：仍保存文件访问状态、快照和超大 Tool Result 落盘，属于尚未完成的旧边界。

`src/prompts` 目前只把 Character Prompt 和旧 `TurnMode` 文本拼成一个字符串。Memory Recall 由 orchestrator 作为额外 user message 注入，Narrative Recall 则由 `packages/conversation` 的 `beforeLlm` Hook 改写消息。也就是说，Ema 已经有压缩算法，却还没有一个拥有明确 Slot 的统一 `ContextAssembler`。

### Diff 判断

1. **V1 收口：保留现有压缩流水线，不重写已经成立的部分。** Micro/Macro、Safe Cut、Restore、失败熔断和 Reactive Compact 已与 Claude 的渐进策略基本对齐。后续应补边界和输入契约，而不是另建第二套 Compactor。
2. **V1 必做：建立唯一 `ContextAssembler`。** Turn Runtime 只提交 Session 快照、当前输入、Profile、模型能力和 Tool Snapshot，由 Context 模块返回不可变的 `ModelRequestContext`。`apps/core`、Hook 和 Engine 不再各自在消息数组中插入内容。
3. **V1 必做：Prompt 采用显式 Slot，而不是整段字符串或猜测位置。** 至少明确固定规则、通用 Tool/Skill/MCP、角色、Profile、Narrative Tool、Memory Recall、当前 Turn 等 Slot；每个 Slot 描述顺序、版本和缓存范围。
4. **V1 收口：Context 与 Memory 彻底分离。** Memory 只返回结构化 `RecallBundle`；Context 决定它是否进入本次模型窗口、放在哪里以及超预算时怎样裁剪。Compaction 不再回流到 Memory 包。
5. **V1 收口：拆除 `agent-context` 杂糅边界。** 超大 Tool Result 的落盘与预览属于 `src/tools/results`；文件访问状态属于 Turn/Tool 工作区状态；压缩后的恢复投影属于 `src/context`。三者不应因为都叫“上下文”留在同一个包。
6. **V1 必做：继续坚持 thinking 不跨 Provider 重放。** Claude 可依赖 Anthropic thinking/signature 语义，Ema 会在一个 Session 中切换 OpenAI、Gemini、DeepSeek 等协议。V1 可以持久化 thinking 供 UI 与审计展示，但下一轮模型请求只重放 text、有效 Tool 调用和结果。
7. **V1 必做：媒体兼容策略保持“历史可降级，本轮失败关闭”。** 历史图片、音频、文件可以使用明确占位或已有描述；用户本轮上传的内容不得被 Adapter 静默吞掉。这比 Claude 单 Provider 假设更适合 Ema。
8. **V1 收口：KV Cache 分成通用策略与协议能力。** Context 负责稳定顺序、快照和前缀指纹；Anthropic 的 `cache_control`、服务端 cache edits、TTL/header 锁存由对应 Adapter 的可选能力实现。不能把 Anthropic 专属字段写进通用 Message 契约。
9. **V1 收口：Token 估算以调用级 Usage 为锚点。** 当前 `estimateLlmInputTokens` 可继续用于预算与增量估计，真实 Provider Usage 负责校准；不应让 LLM 执行包拥有 Session 级 Token 状态。
10. **V1.5 候选：Context Collapse 与异步 Memory Prefetch。** Ema V1 先完成确定性的渐进压缩和 Recall 注入；可逆投影折叠、边生成边预取等优化等真实长会话数据证明必要后再做。
11. **不照搬：`<system-reminder>` 作为内部数据模型。** Ema 内部应使用 `PromptSlot`、`ContextAttachment`、`RecallBundle` 等明确类型，只有在最终序列化给模型时，才由 Prompt/协议层选择 XML 或普通文本边界。

### 建议拆分与公共接口

```text
src/context/
├─ contextAssembler.ts       唯一模型上下文组装入口
├─ contextSnapshot.ts        本轮不可变输入与诊断摘要
├─ messageBuilder.ts         Session Message -> 模型消息投影
├─ messageCompatibility.ts   历史降级与本轮能力校验
├─ promptPrefix.ts           稳定前缀与缓存诊断
├─ compaction/               现有渐进压缩流水线
└─ restore/                  压缩后需要恢复的模型可见状态

src/prompts/
├─ promptAssembler.ts        按显式 Slot 组装 Prompt
├─ slots.ts                  Slot 名称、顺序、缓存范围与版本
├─ profiles/                 Chat/Work 行为差异
└─ serializers/              将结构化 Slot 转为模型可见文本

src/tools/results/           Tool Result 预览、落盘引用与回收
```

建议公共输入输出保持小而明确：

```ts
interface ContextBuildRequest {
  turn: TurnContextSnapshot;
  profile: ExecutionProfile;
  model: ModelCapabilitySnapshot;
  prompt: PromptSnapshot;
  tools: ToolManifestSnapshot;
  recall?: RecallBundle;
}

interface ModelRequestContext {
  messages: readonly Message[];
  tools: readonly LlmToolDef[];
  cache: PromptCacheDiagnostics;
  budget: ContextBudget;
}
```

这里的 Snapshot 是一次 Turn/LLM Call 的不可变投影，不要求复制附件正文或所有大 Tool Result。大型内容仍通过稳定引用和受控读取进入窗口，因此不会因为“做快照”就复制几百 MB 内存。

### 与第 01、02 章复核

- 第 01 章的唯一执行核心不直接拼消息；它依赖 `ContextAssembler.build()`，因此未来 Desktop、CLI、Web 不会各自复制 Prompt 逻辑。
- 第 02 章的 `TurnRuntime` 负责取得 Session/Turn 快照，`TurnLoop` 在每次 LLM Call 前请求 Context 投影并触发 Compactor；两者都不直接访问 Memory 内部 Repo。
- `waiting_user` 时保留的是 Turn Loop 状态，而不是共享可变 Context。恢复后使用相同 Turn 身份重新构建新的模型请求视图。
- Context 输出的 Tool Snapshot 将在第 04 章进入 PreparedToolCall 管线；Context 只告诉模型能看到什么，不执行工具。

---

## 04 Tool System：能力注册、不可变审批与执行边界

### Claude 的业务与架构

Claude 把 Tool 作为模型影响外部世界的唯一出口。它把工具分为定义、组装和执行三层：工具自身声明 Schema 与安全语义；注册表按环境、权限和能力组装模型可见工具；执行器针对同一次调用依次完成查找、验证、Hook、审批、Sandbox、执行、结果格式化和事件发送。默认不可并发、默认视为有副作用、默认不允许自动分类审批，属于 fail-closed。

Claude 的 Tool 接口还直接包含 React 渲染能力，这是其 CLI/Ink 单体应用的工程选择。复杂工具按目录拆分实现、Schema、Prompt、UI 和辅助逻辑；简单工具仍可以保持单文件。

### Ema 当前事实

Ema 已经完成了这一批最重要的安全骨架：

- `src/tools` 提供 `ToolDef`、`buildTool()`、`ToolRegistry` 与 `PreparedToolCall`；
- `ToolRegistry.prepare()` 只解析一次模型参数，深冻结输入和权限元数据，并以 `WeakMap` 证明快照确实由当前 Registry 产生；
- `ToolRegistry.execute()` 拒绝伪造快照，也拒绝 MCP 热更新后仍执行旧审批快照；
- Agent 主链已经采用 `prepare -> PermissionEngine.gate -> execute`；
- `src/builtinTools` 已按 `FileEditTool` 等业务名称整理复杂工具目录，并提供稳定内部 ID；
- 内置与 MCP 工具拥有明确所有者，MCP 批量注册先验证后提交，不允许覆盖内置工具；
- 无物理 Sandbox 时，Bash/PowerShell 从模型可见注册表移除；Artifact 和未接桥的 Skill/Subagent 工具同样不会伪装可用；
- `ToolManifestSnapshot` 已在根 Agent 与 Subagent 主链接入：模型看到的 Schema、`prepare()` 查找和后续执行来自同一份 Registry 快照；伪造快照和同名 MCP 实现热更新后的旧快照都会被拒绝；
- `ToolExecutionContext` 已携带 Session、Turn、ToolCall、AbortSignal、文件状态、Sandbox Runner、AskUser、Subagent、MCP、Skill 与 KB 桥。
- Tool Result 外置已迁入 `src/tools/results`：`maxResultBytes` 默认 50KB，同批结果另受 200KB 聚合预算；持久化预览成为跨 Turn 和重启后的唯一重放事实。
- MCP 动态 Tool 已改用统一 `buildTool()`：Server 原始 JSON Schema 通过 `inputJsonSchemaOverride` 覆盖模型描述，运行时参数仍由宽松 Zod `inputSchema` 保证对象边界；Ema 的结果预算和保守默认值不再因手工构造 `BuiltTool` 被绕过，MCP 协议层 1MB 安全阀继续独立存在。
- `validateInput` 已形成 Schema 后、Permission 前的业务校验入口；`requiresUserInteraction` 已替代 Agent 按 AskUser 工具名猜测等待状态。
- `ToolOrigin` 已把 Builtin 与 MCP 来源纳入 ToolDef、Manifest 和 Prepared 快照；MCP 分支强制携带原始 Server/Tool 名，Registry 会拒绝来源声明与注册所有者不一致的实现。
- ToolExecution Journal 已归入 `src/tools/journal`：Tools 拥有状态、记录、CAS 状态机、崩溃恢复语义和 Store 端口；Storage 只实现原子 SQL 操作，Tasks 不再导出工具执行生命周期。

当前缺口不是再发明 Tool 接口，而是边界仍然过宽：`ToolExecutionContext` 正逐渐成为依赖杂物箱；Registry 仍有可能绕过统一 Prepare/Permission 链的执行入口；Agent 调度与单次 Tool 执行尚未拆开，后台进程和 UI Presentation 也还没有形成清晰的跨端协议。

### Diff 判断

1. **V1 已对齐：PreparedToolCall 必须保留。** 它解决的不是类型优雅，而是“模型提交 A、用户批准 A、实际执行时不能换成 B”的 TOCTOU 安全问题。后续 Hook、自动审批和 UI 都只能查看这份不可变快照。
2. **V1 必做：Tool 生命周期只能有一条主链。** 内置、MCP、Skill 激活后获得的工具都进入相同的 Prepare、Permission、Sandbox、Execute、Result 流程；禁止可信桥或 route 使用 `dispatch()` 绕过审批。
3. **V1 必做：运行时安全默认关闭。** 新工具默认 `isConcurrencySafe=false`、非只读、不可自动批准。工具作者需要显式证明更宽松的语义。
4. **V1 收口：将 ToolContext 改为组合能力，而不是继续加可选字段。** 保留 `identity`、`workspace`、`signal`、`events` 和少量 Capability Port；Artifact、KB、Subagent、AskUser 等由对应工具在注册/构造时注入专用依赖，避免每个工具看到整个产品运行时。
5. **V1 必做：模型可见名与内部稳定 ID 分离。** Permission、审计、恢复和 Feature Gate 使用稳定 ID；Provider Tool Schema 使用名称。重命名展示名不能意外继承或绕过旧权限。
6. **V1 必做：Tool Result 形成结构化结果封套。** 结果要区分成功、失败、取消、超时、输出截断、外置引用和 outcome unknown；不能只返回 stdout 字符串，也不能把日志文本当 SSE 事件。
7. **V1 收口：工具 UI 不进入执行包。** Claude 的 React renderer 适合单体 CLI，Ema 有 Desktop、未来 CLI/Web/移动端，应由 `ToolPresentation` 跨端数据协议描述摘要、风险、文件 diff 和进度，Desktop UI 自己渲染。
8. **V1 已对齐：工具池使用不可变 Session/Turn 快照。** Skill 和 Profile 只能收窄工具能力；MCP 连接变化生成下一次 Snapshot，已开始的 Turn 仍持有原快照，但被移除或同名替换的实现会在 prepare 阶段明确失败，不会偷换成新实现。
9. **V1 收口：Tool 顺序与第 03 章缓存策略衔接。** 内置工具形成稳定前缀，Skill/MCP/角色专属工具按稳定分区追加；不能因为连接顺序或 Map 插入顺序破坏 KV Cache。
10. **V1 必做：AskUser 只属于根 Turn 交互能力。** Subagent 默认工具集不包含 AskUser。若子 Agent 缺少信息，它结束或向父 Agent 发送 `needs_parent_input`，由根 Turn 决定是否询问用户。
11. **V1.5 候选：ToolSearch 延迟加载。** 当 Skill/MCP 数量真正导致 Tool Schema 过大时再加入 Discovery Catalog；V1 先用明确工具快照和启用门禁，不制造半成品搜索工具。
12. **不照搬：Bun 编译宏与每个 Tool 强制 UI 文件。** Ema 用 Tauri/NodeNext Feature Gate；文件拆分按复杂度，而不是为了长得像 Claude 产生几行小文件。
13. **V1 已对齐：结果预算属于统一 Tool 契约。** Builtin 和 MCP 都生成必有 `maxResultBytes` 的 `BuiltTool/PreparedToolCall`；MCP Server 无权自行扩大 Ema 的模型与磁盘预算。`Infinity` 只允许真正具有强制字节上限的工具使用；当前 `FileRead` 的 `offset/limit` 仍可省略，因此继续服从默认结果预算，待 Builtin Tool 审查时再补真正的行数与字节双上限。
14. **V1 已对齐：结构校验与业务校验分层。** Zod/JSON Schema 处理字段形状，`validateInput` 在权限询问前检查工作区和文件状态等语义；失败作为可修正 Tool Result 返回模型，不能让用户批准一个注定无法执行的操作。
15. **V1 已对齐：交互等待是工具能力，不是名称规则。** AskUser 系列显式声明 `requiresUserInteraction`；Agent Scheduler 只读取 Prepared 快照，不维护工具名白名单。
16. **V1 已对齐：来源使用单一可判别字段。** Ema 不复制 Claude 可互相矛盾的 `isMcp + mcpInfo`，而使用 `ToolOrigin = builtin | mcp`；MCP 分支必须同时携带 `serverName/serverToolName`。来源跟随 Manifest 和 Prepared 快照，供 UI、审计和执行策略读取。V1 没有 LSP Tool，因此不预建 `isLsp` 空分支。
17. **V1 已有等价机制：不重复增加同义字段。** `prompt()` 由直接进入 Provider Schema 的 `description` 承担；`isDestructive/isOpenWorld/checkPermissions` 由声明式 `permissionMeta` 与 Permission 规则承担；`isEnabled()` 由 Feature Gate、注册条件与每 Turn Manifest 选择承担；`isSearchOrReadCommand/backfillObservableInput` 属于跨端 `ToolPresentation`，不进入执行定义。
18. **暂不加入：没有当前执行消费者的字段。** `outputSchema` 等结构化 Result 封套确定后再接。Claude 的 `requiresUserInteraction` 与 `interruptBehavior = cancel | block` 是正交能力：前者表示工具主动等待用户并驱动 `waiting_user`，后者表示工具运行期间收到新消息时取消工具还是阻塞新消息；Ema 保留已经接线的前者，等 TurnRuntime 统一用户插话、排队与取消语义后再加入后者。Provider `strict` 由支持该能力的 Adapter 决定，不能假装所有协议都支持；`aliases/inputsEquivalent` 等重命名或调用去重出现真实需求后再设计；ToolSearch 的 `searchHint/shouldDefer/alwaysLoad` 留到 V1.5。

### 建议拆分与公共接口

```text
src/tools/
├─ registry/                 工具身份、所有权、注册与 Snapshot
├─ preparation/              Schema 解析、语义校验、PreparedToolCall
├─ execution/                Hook -> Permission -> Sandbox -> Result
├─ results/                  结果封套、外置、截断、回收
├─ background/               后台进程句柄与取消（不是 Task）
└─ presentation/             跨端工具摘要、风险、Diff 与进度数据

src/builtinTools/            Ema 内置工具实现
src/sandbox/                 Ema 跨平台执行隔离
packages/public-http/        可独立复用的公网请求安全底座
apps/desktop-ui/             ToolPresentation 的桌面渲染
```

不建议让所有 Tool 继承复杂基类。工具作者面向一个小型 `ToolDefinition<Input, Output>`；构建函数补齐保守默认值；执行流水线统一处理横切能力。

```text
ToolIntent
  -> ToolRegistry.prepare()
  -> PreparedToolCall
  -> Hook inspection
  -> PermissionEngine.gate()
  -> Sandbox/Capability runner
  -> ToolExecutionResult
  -> EmaStreamEvent + next model tool_result
```

### 与第 01～03 章复核

- `TurnLoop` 只调 Tool Runtime 公共入口，不直接调具体 Tool，也不自行检查路径权限。
- `ContextAssembler` 使用 `ToolManifestSnapshot` 告诉模型当前能调用什么；执行器使用同一 Snapshot 所属 Registry 验证 `PreparedToolCall`，避免模型所见与实际执行脱节。
- Tool Result 外置后的预览和引用由 Context 决定如何进入下一轮，但原始结果的存储、上限与回收由 Tool Result 模块所有。
- Chat/Work Profile 只能过滤或收窄工具，不产生第二套工具执行流水线。

---

## 05 Code Editing Strategy：低破坏编辑与可恢复写入

> 源文档文件名为 `05-code-editing-strategy.md`，正文标题沿用了“第 10 章”；本评审按文件顺序记为 05。

### Claude 的业务与架构

Claude 优先使用精确 Search-and-Replace 的 FileEdit，而把整文件 FileWrite 限制在创建或完整重写。核心原则是：模型必须给出真实存在且默认唯一的旧文本；已有文件必须先完整读取；读取后被外部修改则拒绝；编辑产生真实 Diff；写入不能静默破坏编码、换行或其他内容。

它没有用行号、AST 或让模型直接生成 Unified Diff 作为核心写入协议，因为这些方案分别容易产生位置漂移、语言覆盖不足、语法错误时失效和严格格式幻觉。

### Ema 当前事实

Ema 的 FileEdit/FileWrite 已经覆盖本章大部分关键工程约束：

- FileEdit 使用非空 `old_string`、`new_string` 和显式 `replace_all`；
- 默认要求唯一匹配，不存在或多次匹配时失败，不猜测目标；
- 支持弯引号归一化匹配；
- Edit 和覆盖 Write 都要求完整 Read 状态，局部读取不能作为覆盖依据；
- 真正提交时重新读取文件并比较 mtime 与内容，两个 Session 基于同一旧版本并发编辑时只有一个能成功；
- 写操作按真实规范路径串行，使用同目录临时文件、`fsync` 和 rename 原子替换；
- 取消或 rename 失败保留旧文件，不回退为直接覆盖；
- 启动恢复只清理由 `toolCallId` 和 `outcome_unknown` Journal 明确关联的临时文件；
- Diff 来自写入前后的真实内容，并有 2 MiB 计算上限和 200K 字符展示上限。

这说明 Ema 的代码编辑不是待重写模块，而是一块已经比早期 Bug 文档描述更完整的实现。

### Diff 判断

1. **V1 已对齐：保留 Search-and-Replace、先读守卫和唯一匹配。** 不增加基于行号的第二套编辑接口，也不让模型直接控制 patch hunk 行号。
2. **V1 已对齐：原子写与 Journal 恢复保留。** 这套设计已经考虑并发 Session、进程崩溃和断电留下临时文件，是第 04 章 Tool Result/Execution Journal 的具体实例。
3. **V1 必做：路径授权必须覆盖请求路径与规范目标路径。** Permission 审批时既检查用户/模型看到的路径，也检查 `realpath` 解析后的目标；软链接、junction 和 Windows UNC 不能在批准后逃逸。
4. **V1 收口：明确 UTF-8 产品政策。** 当前原子写固定 UTF-8。V1 若只承诺 UTF-8，应在 FileRead 检测 BOM/二进制/非法 UTF-8 并明确拒绝不可安全写回的编码，而不是解码后悄悄损坏。是否兼容 UTF-16 应作为单独能力，不混入本轮架构迁移。
5. **V1 收口：Write 空操作和覆盖语义统一。** 写入内容与当前文件完全相同时返回 `unchanged`，不制造假的文件变更事件；FileEdit 的 `old_string === new_string` 也应在准备阶段拒绝。
6. **V1 收口：Notebook、图片、PDF 等非普通文本走专用读取/编辑能力。** FileEdit 不应把这些文件当 UTF-8 文本试写。V1 没有 Notebook Editor 时应 fail-closed，而不是模仿 Claude 暴露不存在的能力。
7. **V1 收口：Diff 是 Presentation，不是执行输入。** 后端根据实际 before/after 生成有界结构；前端可以选择统一 diff、左右对比或折叠显示，但不能影响实际写入内容。
8. **V1.5 候选：语义等价编辑去重、配置文件专用 Schema 校验。** 只有真实重试数据表明重复编辑是问题时才做语义去重；对 Ema 自己的关键配置可增加领域校验，但不建立万能 AST 编辑层。
9. **不照搬：Claude API 的 XML desanitization。** 这是其模型/API 特有兼容层。Ema 若某个 Provider 出现同类转换，应放在该协议适配或明确兼容工具中，不污染通用 FileEdit。

### 建议拆分与公共接口

现有复杂工具目录结构基本合理，不需要继续拆碎：

```text
src/tools/builtin/FileEditTool/
├─ FileEditTool.ts            Schema、校验与执行协调
├─ matching.ts                精确匹配、引号归一化、唯一性
└─ presentation.ts            可与 FileWrite 共用真实 Diff 构造

src/tools/builtin/FileWriteTool/
├─ FileWriteTool.ts
├─ atomicWrite.ts             路径锁、临时文件、fsync、rename
└─ recovery.ts                Journal 驱动的中断清理

src/tools/files/
└─ fileAccessPolicy.ts        编码、普通文本类型和规范路径公共校验
```

`atomicWrite.ts` 与 `recovery.ts` 不是为了形式产生的小文件，它们分别承载跨 Edit/Write 复用的提交原语与启动恢复边界，拆分有真实理由。

### 与第 03、04 章复核

- Context 的文件状态只保存模型本轮已经看到的完整版本与最近访问投影；实际文件写入一致性由 Tool 执行层再次校验，不能只信 Context 缓存。
- `PreparedToolCall` 冻结的是原始编辑意图，Permission 同时批准规范化路径和变更摘要；实际提交前仍执行乐观并发校验。
- `ToolExecutionResult.presentation` 携带真实 Diff，模型收到有界结果，Desktop 收到结构化展示数据；两端不需要共享 React 组件。
- 写入完成后的文件状态可供下一次 Context 组装使用，但不会把完整大文件复制进每个 Session Snapshot。

---

## 06 Hooks and Extensibility：内部生命周期与未来用户扩展

> 源文档文件名为 `06-hooks-extensibility.md`，正文标题沿用了“第 7 章”；本评审按文件顺序记为 06。

### Claude 的业务与架构

Claude 的 Hook 是面向用户、项目、插件和 SDK 的正式扩展协议，覆盖 Tool、Permission、Session、Stop、Subagent、Task、Compaction、MCP 和环境变化。可执行形态包括 Command、Prompt、Agent、HTTP、Callback 和会话 Function；执行前会做来源信任、Matcher/条件过滤、去重、超时、并发和输出协议解析。

这套能力的安全成本很高：Command Hook 等同本地代码执行，HTTP Hook 需要 SSRF 和凭据白名单，Prompt/Agent Hook 会产生额外模型调用，Permission Hook 甚至可能改变安全决策。Claude 为此维护配置快照、信任确认、环境变量白名单、CRLF 防护和稳定 JSON 协议。

### Ema 当前事实

Ema 当前的 `packages/hook` 是**进程内业务生命周期总线**，并不是 Claude 那种用户可配置 Hook 平台：

- 事件覆盖 LLM、Assistant Message、Tool、Compaction 和 Turn 生命周期；
- `HookContext` 明确携带 `invocationId/sessionId/turnId`，LLM payload 另有 `iteration/llmCallId`，Tool payload 另有 `ToolCallId`；
- payload 每个 handler 独立 clone + freeze，handler 无法通过共享引用修改 Engine 状态；
- 控制事件与观察事件分开，观察事件返回 abort/replace 会被视为协议违规；
- 串行 replace 有明确传递顺序，并行 handler 不允许 replace；
- 每个 handler 有 AbortSignal、超时、critical/fail-open 语义、并发上限、结构化 trace 与 warning；
- Tool Hook 被刻意限制为观察用途，不能授权、拒绝、改参或绕过 Sandbox；
- Narrative 目前仍通过 `beforeLlm` replace 整个 messages 数组注入检索结果，说明显式 Context Slot 尚未接线。

这比早期单纯 callback 列表成熟，但它仍是内部 API。数据库里没有用户 Hook Definition/HookId，Settings 没有启停和来源信任，Command/HTTP/Prompt Hook Runtime 也不存在。

### Diff 判断

1. **V1 已对齐：身份、不可变 payload、超时与事件控制权限保留。** 多 Session 与同 Session 多 LLM/Tool 调用已经能靠 ID 区分，不需要再塞一个模糊 `ctx.meta`。
2. **V1 必做：内部 Hook 不能成为第二套 Permission Engine。** `beforeToolUse` 继续只观察已准备调用；是否允许执行只由 Permission 决定，隔离只由 Sandbox 决定。未来用户 Hook 也不能返回一个未经重新 Prepare 的任意工具输入。
3. **V1 收口：replace 改成领域 Patch/Slot，而不是替换大 payload。** `beforeLlm` 不应长期允许任意替换整个 Message 数组；Narrative、Memory、Skill 等应返回明确 `ContextContribution`，由 ContextAssembler 统一装配和验证。
4. **V1 收口：注册采用“领域拥有、Composition Root 汇总”。** 每个业务模块导出 `registerXxxHooks(bus, deps)`，`apps/core` 的装配入口统一调用，因此开发者能从一个位置看见启用了哪些 Hook，又不把所有业务实现塞进 Hook 包。
5. **V1 收口：Hook Event 只表达稳定生命周期节点。** 不因为某个组件想监听就增加事件；纯 UI 通知继续走 `EmaStreamEvent`。Character/Emotion 变化绕过 HookBus 的选择是合理的。
6. **V1 收口：failure phase 与错误码保持明确类型。** Hook 只传安全、可展示的错误摘要；原始 Provider body、API Key、命令环境等不能进入通用 payload 或 trace。
7. **V1.5 候选：用户可配置 Hook。** 等内部事件和 Prompt Slot 稳定后，再增加 `HookDefinitionId`、启用状态、作用域、事件、Matcher、执行类型、超时和来源信任；不要现在把半成品 SQL/UI 混入 V1 主链。
8. **V1.5 候选：Command/HTTP/Prompt Hook 分别实现专用 Runner。** Command 必须走 Sandbox，HTTP 必须走 `public-http`，Prompt 必须通过独立 LLM Call 且禁止递归触发同类 Hook；三者不能共用一个 `payload: JSON` 万能执行器。
9. **V1.5 候选：Stop Hook。** 它本质是“采样后验证是否允许 Turn 停止”，可与第 17 章 Goal 判定接口对接；V1 不应为了模仿 Claude 暗中让测试 Hook 无限续跑。
10. **不照搬：Claude 的 27 个事件和退出码协议。** Ema 是桌面产品而非 shell-first CLI，只添加真实业务需要的事件；跨平台 Command Hook 也不能默认用户一定有 Bash。

### 建议拆分与公共接口

```text
src/hooks/
├─ hookBus.ts                 当前强类型内部总线
├─ events.ts                  稳定领域生命周期事件
├─ payloadSnapshot.ts         handler 隔离与只读快照
├─ errors.ts
├─ registrations.ts           Composition Root 可扫描的注册清单
└─ contributions.ts           Context Patch 等受限返回类型

未来 V1.5：
src/hooks/configuration/      HookDefinition、作用域、来源与信任
src/hooks/runners/            command/http/prompt 专用执行器
src/settings/hooks/           用户设置读写，不塞进 Memory
```

建议未来用户 Hook 主键叫 `hookDefinitionId` 或 `hookId`，单次执行身份继续使用现有 `hookInvocationId`，两者不能混用。已知字段进显式 SQL column；只有某类 Hook 真正开放的执行配置才使用对应的判别联合，不建立 `options_json/meta_json`。

### 与第 01～05 章复核

- `TurnRuntime` 决定何时触发生命周期事件；HookBus 不拥有 Turn 状态机。
- `beforeLlm` 的 Context Contribution 交给第 03 章 `ContextAssembler`，Hook 不再直接拼 Message。
- `beforeToolUse` 观察第 04 章的 `PreparedToolCall`；即使未来 Hook 建议改参，也必须重新 Prepare、重新计算摘要并重新审批。
- FileEdit 的实际 Diff 与写入 Journal 可由 afterToolUse 观察，但 Hook 失败不能回滚一个已经原子提交成功的文件并把结果伪装成未执行。
- Stop/Goal、Subagent、Task 等事件是否加入，要等对应领域对象成立，不能用 Hook 事件反向创造空业务。

---

## 07 Multi-Agent：子 Agent 运行、协调与资源边界

### Claude 的业务与架构

Claude 区分三种多 Agent 形态：父 Agent 派生一次性 Subagent；Coordinator 将工作拆给多个 Worker；更复杂的 Swarm/Team 共享任务清单并通信。子 Agent 可以继承父上下文，也可以从干净上下文启动；有独立 Agent 身份、工具白名单、权限上下文、模型、取消信号和 Usage，结果再返回父 Agent。

Claude 源码还有一条容易被名称掩盖的边界：普通同步/异步 Agent 会被过滤掉 TaskOutput、TaskStop、AskUser 和 Agent 等元工具，也不会获得 `TaskCreate/Get/List/Update`。只有启用 Swarm 后的 in-process teammate 才额外得到四个 Task Tools 和 SendMessage，并使用稳定 teammate name 作为 Task owner。AgentTool 自身没有“结构化工作项 taskId”输入；源码里大量 `taskId` 只是后台 Agent/Shell 执行句柄。这正说明工作项 Task、子 Agent Run 和后台进程必须按语义重新命名，不能照抄 Claude 的历史命名。

多 Agent 的难点不是 `Promise.all`，而是能力隔离、上下文继承、预算、父子取消、后台完成通知、结果去重和终态收口。Claude 还将 Plan 两阶段流程与多 Agent 配合，但这不意味着每个 Subagent 都是一个 Task 或 Plan。

### Ema 当前事实

`src/agent/spawner.ts` 已有一个可工作的 V1 Subagent Runtime：

- 支持同步 spawn 与后台 spawn/await/send-message/abort；
- 父 Turn AbortSignal 向子 Agent 级联，单个子 Agent 也能独立取消；
- 父 Turn 收口时 `shutdown()` 会取消并等待所有未显式 await 的后台子 Agent；
- 整个父 Turn 与全部子 Agent 共享 `TurnBudget`，限制墙钟时间、Token、Tool Call、总 Subagent 数和并发数；
- `fork` 继承父消息并设置缓存断点，`subagent` 使用干净上下文；
- Subagent 没有父工作区，默认只获得 Web、Todo、Scratchpad，以及确实注入的 KB/Skill/MCP 能力；不包含 AskUser、文件写入和继续派生 Subagent；
- Scratchpad 在主 Agent 与子 Agent 间共享，Mailbox 在每次 LLM 迭代边界一次性排空；
- 子 Agent 的 started/progress/stream/completed/failed/aborted 都进入父 Session SSE。

但身份与持久化仍混乱：`subagentId` 被强制转换成 `TurnId` 传给 Tool Context，Tool Journal 又使用父 `turnId`；`AgentTaskStore` 保存的是 running/completed/failed/cancelled 的执行记录，而不是第 15 章的结构化工作项；`SubagentSpawnOpts.taskId` 已存在却被注释为 V1.5 且没有 Tool 输入接线，`SubagentResult` 和后台控制仍只暴露 `subagentId`。当前子 Agent 工具集还包含旧 `TodoWrite`，会在独立内存清单中写出与根 Turn 不一致的待办。当前后台 Agent 也要求父 Turn 结束前 await，本质仍是 Turn 内并发，不是真正跨 Turn 后台运行。

### Diff 判断

1. **V1 已对齐：保持一层 Subagent 和父级资源预算。** 当前禁止递归派生是合理产品约束，避免无限资源、Mailbox 环和复杂级联取消；V1 不需要 Coordinator/Swarm 万能框架。
2. **V1 必做：建立独立 `AgentRunId`。** Subagent 运行不能伪装成 Turn。Tool、Hook、Usage 和事件需要明确携带 `agentRunId`，同时保留真实 `sessionId/parentTurnId`；根 Agent 不再建立重复 AgentRun 投影，Turn 是唯一根执行与用户交互终态。
3. **V1 必做：重命名旧 `AgentTaskStore` 语义。** 其状态、父子运行关系、迭代数和 Usage 属于 `AgentRunStore`。第 15 章的 Task 另有 subject/status/owner/blockedBy，不能复用同一张表或同一接口。
4. **V1 必做：后台 Agent 终态必须可审计。** V1 若规定后台 Agent 只能活在父 Turn 内，就必须在 Turn 终态前 await/cancel 并完成 Tool 终态；不可用 `.catch(() => {})` 作为唯一失败处理。当前 SSE 已报告失败，但还需运行记录承担恢复审计。
5. **V1 收口：工具能力使用 Snapshot 交集。** Subagent Tool 集 = Profile 允许 ∩ 父 Agent 可用 ∩ Subagent 类型允许 ∩ Skill 限制 ∩ 当前 Bridge 可用。任何层只能收窄，不能靠名字重新扩大。
6. **V1 收口：上下文继承由 Context 模块构建。** `fork` 不应在 Spawner 中手工复制 Message 并打 cacheBreakpoint；由第 03 章 `ContextAssembler.forkForAgentRun()` 产生稳定、可裁剪的只读前缀。
7. **V1 收口：Mailbox 是 AgentRun 通信，不是用户 Prompt。** 消息必须带 sender/target/messageId，单次消费并可审计；子 Agent 请求用户信息时发 `needs_parent_input` 给父 Agent，而不是直接访问 AskUser。
8. **V1 收口：Scratchpad 只是 Turn 内临时协作面。** 它不等于 Task Store、Memory 或持久 Artifact；Turn 结束清理，真正需要保留的结论由父 Agent写入正常结果或明确业务存储。
9. **V1.5 候选：真正跨 Turn 的后台 AgentRun。** 只有在持久 Lease、心跳、恢复、通知和用户管理 UI 完成后，才能允许父 Turn 结束后继续运行。
10. **V1.5 候选：Coordinator/Team。** 先复用 AgentRun + TaskList + Mailbox 三个清晰对象，再增加协调策略；不创建一个同时代表 Task、Worker、Job 和 Goal 的万能 Runtime。
11. **不照搬：Claude coding 专属 Agent 类型与 Worktree 组合。** Ema 的 Agent 类型应围绕通用研究、KB/Narrative、角色工作流定义；代码隔离需要时使用已有 Sandbox/Workspace 能力。
12. **V1 必做：Task Tools 只属于根 Turn。** Ema V1 没有稳定 teammate 身份，普通 Subagent 不得到 `TaskCreate/Get/List/Update`，也不靠共享清单自行抢活。其工作说明必须在启动时成为自包含、不可变输入；缺少信息时通过 AgentRun Mailbox 或最终结果交还父 Turn。
13. **V1 必做：Subagent 与 Task 只做可选关联。** Subagent Tool 可接受已有 `taskId`，但不得隐式创建 Task。启动事务验证 Task 与父 Turn 同 Session、未终态、依赖已满足且没有其他活动 AgentRun；成功后创建独立 `agentRunId`。不带 Task 的探索 Run 继续合法。
14. **V1 必做：Run 终态不驱动 Task 终态。** AgentRun 成功、失败或取消只结束本次尝试并释放活动绑定；Task 保持原业务状态，由根 Agent 校验结果后显式调用 `TaskUpdate`。`SubagentAwait/SendMessage/Abort` 一律寻址 `agentRunId`，Task UI 只展示关联，不承担运行控制。

### 建议拆分与公共接口

```text
src/agent/
├─ turnRuntime.ts
├─ loop/
├─ runs/
│  ├─ agentRun.ts             身份、父子关系、状态与 Usage
│  ├─ agentRunStore.ts        持久执行记录（旧 AgentTaskStore 迁入）
│  ├─ subagentSpawner.ts      启动、取消、等待与终态
│  ├─ runMailbox.ts           AgentRun 间消息
│  └─ runBudget.ts            根 Turn 共享资源预算
├─ capabilities/
│  └─ agentToolScope.ts
└─ scratchpad/                Turn 内临时协作

src/tasks/                    第 15 章工作项，不属于 runs/
```

建议事件身份至少满足：

```ts
interface AgentRunCorrelation {
  sessionId: SessionId;
  parentTurnId: TurnId;
  agentRunId: AgentRunId;
  parentAgentRunId?: AgentRunId;
  taskId?: TaskId;
}
```

`taskId` 可选，意味着一次 AgentRun 可以执行某个 Task；没有 Task 的临时调查 Subagent 同样合法。反过来，一个 Task 也可能经历多次 AgentRun 重试或由人工完成。

V1 每次真实启动子 Agent 创建一条 `agent_runs`，保存 `sessionId/parentTurnId/parentAgentRunId?/taskId?/purpose/status/providerConfigId/modelId/iterations/toolCallCount/inputTokens/outputTokens/outputExcerpt/errorCode/errorMessage/version/startedAt/updatedAt/completedAt`。它不是一条 Tool Result：指令、Assistant 文本、Reasoning、Tool Call、Tool Result 和协调消息按单调 sequence 存入 `agent_run_messages`；开放 Tool 参数可以使用受控 JSON，已知身份、错误、耗时和结果预览使用显式列。完整大结果继续使用 Tools 外置引用，不复制进 Run 行。

### 与第 01～06 章复核

- 所有 AgentRun 复用同一个 `TurnLoop` 实现，但根 Turn Runtime 才拥有用户交互终态和 AskUser。
- Context Fork 由 Context 模块投影，Spawner 不拥有 Message 格式与 Provider cache 字段。
- Subagent Tool Call 仍走同一 Prepared/Permission/Sandbox 管线；白名单不是权限替代品。
- Hook 使用 `agentRunId` 区分父子执行；不会把 `subagentId` 塞进 `turnId` 欺骗类型系统。
- 第 15 章 Task 只负责“要完成什么”，本章 AgentRun 负责“谁在执行、执行到哪、消耗多少”。

---

## 08 Memory System：长期记忆，而不是 Context 或项目文档缓存

> 源文档文件名为 `08-memory-system.md`，正文标题沿用了“第 6 章”；本评审按文件顺序记为 08。

### Claude 的业务与架构

Claude 的 Memory 更接近“按项目隔离的个人 Markdown 知识库”：只保存无法从代码/Git/CLAUDE.md 重新推导的用户偏好、反馈、项目决策和外部引用。`MEMORY.md` 是紧凑索引，详细记忆分文件存放；召回先扫描 frontmatter，再用模型选择少量相关文件，并防止同一 Session 重复注入。

它的核心原则值得保留：权威源中能查到的事实不进入长期记忆；索引与正文分离；召回数量受 Context 预算约束；用户纠正和正面反馈都可形成记忆；所有自动写入都必须可查看、可修正。

### Ema 当前事实

Ema Memory 是更通用的本地长期记忆系统，不是 Claude 的 Markdown 目录翻版：

- L0 是 `profile.db` 中全局实体节点与关系图；
- L1 是 `data.db` 中按 Session 保存的 Note；
- L2 是 `profile.db` 中全局 Episodic Item；
- Recall Planner 并行召回三层，向量不可用时可降级，并可选 Rerank；
- `MemoryPlanner.applyRecallToMessages()` 当前直接构造模型 Message；
- `beforeLlm` Hook 只在本 Turn 第一次逻辑 LLM Call 召回，并 replace 整个 messages；
- Turn 成功后将 user/assistant 正文写入 pending fragments，达到 Token/Turn 阈值后由 session-scoped extraction worker 提取；
- 全局 L0/L2 maintenance 与 session extraction 已在设计上分开，自动维护只衰减，删除仍由用户决定；
- Context Compaction 已迁到 `src/context`，但 L1 Note 自身过长时的 Note 瘦身仍属于 Memory 数据维护。

当前仍有四个边界问题：`PlanContext` 名称与 Plan Mode 冲突；Memory 自己把 RecallBundle 格式化成 ModelMessage；AlreadySurfaced 仍描述为 `session.meta_json` bucket；L1 Note body 是 JSON `SessionNoteEntry[]`，并通过文本兼容旧格式。

### Diff 判断

1. **V1 必做：保持 Ema 的三层长期记忆，不照搬 Markdown 文件系统。** Ema 是本地角色 Agent，不只服务单个代码仓库；全局用户偏好、跨 Session 片段和 Session Note 有真实产品价值。
2. **V1 必做：Memory 输出 `RecallBundle`，不输出 ModelMessage。** Memory 负责检索、排序、证据和预算建议；第 03 章 ContextAssembler 决定插槽、文本序列化和最终裁剪。
3. **V1 收口：`PlanContext` 改为 `MemoryRecallContext`。** 它只携带 recall query、Session/Turn、Profile 和取消信号，与第 10 章 Plan 没有关系。
4. **V1 必做：Memory 写入只在 Turn 明确成功后发生。** 失败、取消、等待用户和 outcome unknown 不能被当作稳定事实提取；thinking、原始 Tool 噪声和 Provider 错误正文不进入长期记忆。
5. **V1 必做：Extraction Worker 遵守 Lease/CAS/恢复。** 同一 pending fragment 不能被两个 Worker 重复提交；断电后 running lease 可过期重领；L0/L1/L2 更新与 fragment 消费使用可审计事务边界。
6. **V1 收口：全局 L0/L2 与 dataDir Session 队列继续物理分开。** 全局 maintenance 不得塞进当前 data.db 的 `memory_tasks`；多个 Session/窗口并发召回可以读共享索引，重建/替换索引需要版本快照而非全局占用锁。
7. **V1 收口：已知持久字段不再藏在 `session.meta_json`。** AlreadySurfaced 至少建立明确 Repo/表或独立 typed column，以 Session + memoryId + kind + surfacedAt 表达 TTL，不能让调用方猜 JSON bucket。
8. **V1 收口：L1 Note 的结构需要明确迁移方向。** 若保留多 Entry，应使用明确 entry schema/表；若产品最终只要一份滚动 Note，则 body 就保存可直接使用的文本并把时间/版本放 column。不要长期同时维护“JSON 数组或任意纯文本”双语义。
9. **V1 必做：Memory 可由用户禁用、查看、编辑和删除。** Settings 控制召回/提取层级，数据页面管理真实条目；自动衰减不能偷偷硬删用户记忆。
10. **V1 收口：采用封闭的 Memory Kind。** Claude 的 user/feedback/project/reference 可作为产品语义参考，但 Ema 应根据角色、偏好、关系、事件等实际召回结构定义有限枚举，不开放自由 `meta` 标签替代领域字段。
11. **V1.5 候选：模型驱动的相关记忆预取。** 当前三层并行 Recall 已经足够；等有延迟证据后再把召回与首轮生成重叠，必须保证结果只消费一次且不在模型完成后污染已结束 Turn。
12. **不照搬：项目 Git Root 路径与 MEMORY.md 索引。** Ema 的 Profile/Data 数据边界比仓库目录更稳定；Markdown 导入导出可以是用户功能，但不应成为内部唯一事实源。

### 建议拆分与公共接口

```text
src/memory/
├─ memoryService.ts           对外协调 recall/extraction/maintenance
├─ recall/
│  ├─ recallPlanner.ts
│  ├─ layer0Graph.ts
│  ├─ layer1Notes.ts
│  └─ layer2Episodic.ts
├─ extraction/
│  ├─ extractionWorker.ts
│  ├─ extractionPipeline.ts
│  └─ extractionCommit.ts
├─ maintenance/
├─ indexing/
├─ settings.ts
└─ types.ts
```

`MemoryPlanner` 当前确实协调多层召回、提取、索引和维护，存在真实简化入口的理由；可以保留名称或改成 `MemoryService`，没必要为了统一后缀改叫 Facade。更重要的是外部只能依赖它的公共接口，不能穿透 Repo。

```ts
interface RecallBundle {
  graph?: GraphRecall;
  sessionNote?: SessionNoteRecall;
  episodes?: EpisodicRecall;
  evidence: readonly RecallEvidence[];
  estimatedTokens: number;
}
```

### 与第 01～07 章复核

- TurnRuntime 在明确成功后通知 Memory 接收已完成 Turn，Memory 不拥有 Turn 终态。
- RecallBundle 作为第 03 章独立 Slot 输入，不再由 Hook replace Message 数组。
- Memory Extraction 使用领域 Job/Worker，不叫 Agent Task；它可以独立运行，也可以被其他领域触发。
- Subagent 默认可以通过受限 Memory/KB Tool 查询，但不能直接修改全局记忆；需要写入的候选由父 Turn 成功后统一提取。
- Hook 只负责触发生命周期，Memory 的幂等、事务和恢复不能依赖 Hook 刚好只调用一次。

---

## 09 Skills System：可发现的指令包与能力收窄

> 源文档文件名为 `09-skills-system.md`，正文标题沿用了“第 5 章”；本评审按文件顺序记为 09。

### Claude 的业务与架构

Claude Skill 是包含 `SKILL.md` 与可选资源的自包含指令包。启动时只加载 name/description/when-to-use 等轻量目录，实际调用时再读取正文；用户手动调用和模型自动调用汇合到同一执行路径。Skill 可以 inline 注入当前上下文，也可以 fork 子 Agent；`allowed-tools`、model、effort、路径条件和 Hook 等 Frontmatter 控制执行环境。

其安全关键点是来源信任：远程 Skill 不能因为正文里写了命令就自动执行；工具限制与 Permission 分层；资源路径必须保持在 Skill Root 内；大量 Skill 的目录需要预算和延迟加载。

### Ema 当前事实

Ema 已实现一套相对完整的 Skill 安装和运行基础：

- 一个 Skill 是目录中的 `SKILL.md` 加 sibling assets；
- Frontmatter 明确定义 name/version/description/argument-hint/allowed-tools；
- SQL 保存可重建索引，正文事实源仍是磁盘；
- Store 对 Root、realpath、只读 builtin、名称碰撞、目录大小和文件数做约束；
- 安装/重命名使用目录事务，失败回滚；删除先删可重建索引，文件失败时下次扫描可恢复；
- Marketplace 安装通过受限 HTTP，支持 SHA-256、Bundle 总量、单文件、路径穿越和镜像降级；
- Runner 只向模型注入轻量目录，调用 `SkillCall` 时才读取和渲染正文；
- `allowed-tools` 通过 Tool Capability Scope 做交集收窄，不授予 Permission；
- 当前目录注入仍依赖 `beforeLlm` 修改 system message，并硬编码只在旧 `agent` mode 出现。

Ema 目前只实现 Inline 风格激活，没有必要为了文档对齐立即增加 Fork Skill；资源文件已经能安装，但不会仅因出现在 Markdown 中自动执行 Shell，这反而是更安全的 V1 选择。

### Diff 判断

1. **V1 已对齐：继续使用目录包、轻量 Catalog 与正文懒加载。** 不把几十份 Skill 正文永久塞进 System Prompt，也不把 SQL 当 Skill 正文事实源。
2. **V1 必做：移除旧 `mode === agent` 判断。** Skill 可见性由 `ExecutionProfile` 和当前 Tool Snapshot 决定：只有 `SkillCall` 真正可用时才展示 Catalog；Chat/Work 哪些 Skill 可用由 Profile 策略显式配置。
3. **V1 必做：Skill 激活只返回结构化 Context Contribution。** Runner 不再查找并拼接 system message。正文进入专用 Prompt Slot，带 skillId/version/source 和缓存范围；重复激活、参数变化与 Session 生命周期可诊断。
4. **V1 必做：`allowed-tools` 只能收窄。** 它与父 Agent 工具能力取交集，之后每次 Tool Call 仍走 Permission/Sandbox；Skill 不得通过 Frontmatter 自动批准命令。
5. **V1 收口：用户手动与模型调用汇合。** 前端点击/命令激活和模型 `SkillCall` 都调用同一个 `SkillService.activate()`，不能一条路径做校验、另一条直接读文件。
6. **V1 收口：安装来源与运行信任分开。** `source=builtin/user/market` 描述来源，不等于自动信任等级。市场 Skill 安装前展示来源、哈希、文件清单和权限声明；启用不等于允许其脚本执行。
7. **V1 必做：V1 不支持 Markdown 内联 Shell 自动执行。** Skill 若需要脚本，由 Agent 明确调用 Bash/File 等 Tool，产生 Prepared Call 和权限卡；这样 Windows/macOS/Linux 的行为也不会藏在 Prompt 预处理阶段。
8. **V1 收口：Catalog 有稳定预算。** 描述设置单项上限，总目录根据模型 Context Window 分配小比例；超限时保留 builtin/已固定 Skill 的描述，普通市场 Skill 降级为短描述或按需搜索。
9. **V1 收口：Skill 与 MCP 不继续混在 Marketplace Runtime。** Marketplace 是发现/下载控制面；Skill Store/Runtime 和 MCP Client 是不同执行面，仅共享 `public-http`、安装校验和 UI 市场基础设施。
10. **V1.5 候选：Fork Skill。** 将 `context: fork` 映射到第 07 章 AgentRun，继承明确的模型与能力快照；不再创造专用 Skill Engine。
11. **V1.5 候选：Skill 级 Hook 和路径条件。** 等 Hook 信任模型与跨平台路径匹配稳定后再开放；未知 Frontmatter 字段不能悄悄生效。
12. **不照搬：Claude 的模型/effort 字符串和项目 Git 路径语义。** Ema 使用 Provider+Model 精确绑定与自己的 Workspace/Profile，不让 Skill 用裸 modelId 猜 Provider。

### 建议拆分与公共接口

```text
src/skills/
├─ skillService.ts            列表、激活、启停与统一入口
├─ skillCatalog.ts            有界的模型可见摘要
├─ skillStore.ts              文件事实源与 SQL 索引协调
├─ skillParser.ts             明确 Frontmatter Schema
├─ skillInstaller.ts          Bundle 校验和目录事务
├─ skillRoots.ts              builtin/user/market 路径边界
└─ types.ts

src/marketplace/              Skill/MCP 等来源目录与下载控制面
packages/public-http/         受限公网请求技术底座
```

建议稳定身份使用 `skillId`，展示/调用名称使用 `name`，版本更新不能只靠同名覆盖而丢失审计：

```ts
interface ActivatedSkill {
  skillId: SkillId;
  name: string;
  version: string;
  source: SkillSource;
  contribution: PromptContribution;
  toolRestriction: ToolCapabilityRestriction;
}
```

### 与第 03、04、06、07 章复核

- Skill Catalog 与正文分别进入 Prompt 的稳定目录 Slot 和动态激活 Slot，服从 Context 预算与 KV Cache 顺序。
- Skill 只能收窄第 04 章 Tool Snapshot，不能改变 Permission 结果或直接执行 asset。
- 未来 Skill Hook 使用第 06 章用户 Hook 信任机制，不在 Parser 中另起一套执行器。
- Fork Skill 直接创建 AgentRun；Task 是否存在取决于它是否在执行一个明确工作项，而不是由 Skill 自动创建。

---

## 10 Plan Mode：先降权探索，再由用户批准执行

> 源文档文件名为 `10-plan-mode.md`，正文标题沿用了“第 9 章”；本评审按文件顺序记为 10。

### Claude 的业务与架构

Claude Plan Mode 的本质不是“模型输出一段计划”，而是一个真实权限状态机：进入时保存原 Permission Mode 并主动降为只读；探索、设计、询问和写计划后，向用户提交可编辑计划；批准后恢复进入前权限，拒绝则继续保持只读。Plan 状态要支持重入、恢复、Fork 隔离、压缩后提醒和断路器变化。

Plan 是用户级控制面，子 Agent 不能自行进入或等待用户批准。计划可以驱动多个 Explore/Plan Agent，但这些只是 AgentRun；最终审批与状态转换仍由根 Session/Turn 所有。

### Ema 当前事实

Ema 只有 `PlanModeTools.ts` 草稿：`PlanEnter` 发送一条 system warning 并返回 active，`PlanExit` 发送完成提示；它没有只读 Tool Snapshot、Permission 策略切换、计划持久化、审批、拒绝、重入和恢复。因此这些工具被明确注释为 V1.5 草稿，`registerBuiltinTools()` 不注册，测试也验证模型看不到它们。

这个状态处理正确：保留设计占位但不伪装产品已经具备 Plan 安全语义。

### Diff 判断

1. **V1 保持现状：Plan 工具不注册。** V1 Work 模式可以用普通文本先说明方案，但不能向用户宣称已进入强制只读 Plan Mode。
2. **V1.5 必做：Plan 是 Work Profile 下的执行子状态，不是第三个顶层模式。** 用户仍只看到 Chat/Work；`PlanState=inactive/exploring/awaitingApproval/approved/cancelled` 单独存在，避免旧 `TurnMode` 再膨胀。
3. **V1.5 必做：进入 Plan 时冻结并收窄 Tool Snapshot。** 只允许明确的读取、搜索、Task/Plan 编辑和 AskUser；即使旧 Permission 有“本会话允许写入”，Plan 期间也不能继承为可写。
4. **V1.5 必做：退出必须由用户审批。** 模型调用 `SubmitPlan` 只产生审批请求，不能自行切回执行；用户可批准、编辑后批准、要求修改或取消。
5. **V1.5 必做：审批后重新建立执行快照。** 不能直接恢复进入前对象引用；需要重新读取当前 Feature Gate、Sandbox、Provider、Workspace 和 Permission Rules，防止 Plan 期间环境已变化。
6. **V1.5 必做：Plan 持久化使用明确领域对象。** 建立 `planId/sessionId/createdTurnId/status/version/body/createdAt/updatedAt`；正文可以是 Markdown，身份和状态用 column，禁止藏进 Session meta JSON。
7. **V1.5 必做：Root Turn 才能等待 Plan 审批。** Subagent/Agent Hook 遇到需要方向选择时返回提案给父 Agent；不直接调用 PlanEnter，也不占用用户 Prompt 队列。
8. **V1.5 收口：Plan 与 Task 分离。** Plan 描述实施方式；批准后可以创建/更新多个 Task 跟踪工作，但 Plan 不是 Task 列表，Task 完成也不自动证明 Plan 全部目标成立。
9. **V1.5 收口：Context 使用 Plan Slot 与节流提醒。** 首次完整注入只读约束，后续用短提醒；压缩后必须恢复当前 Plan 状态与批准后的最终版本。
10. **不照搬：随机本地 Markdown slug 与订阅等级决定 Agent 数。** Ema 以 SQL Plan 身份和可导出 Markdown 为主；并行探索数量由本地 Settings/Turn Budget 决定，不依赖商业订阅等级。

### 未来拆分与接口

V1 不创建这些空目录；实现 V1.5 时建议：

```text
src/plans/
├─ planController.ts          状态转换与唯一公共入口
├─ planStore.ts               明确持久字段和 CAS version
├─ planToolPolicy.ts          只读 Tool Snapshot 收窄
├─ planApproval.ts            Session 级审批与 promptId
├─ planContext.ts             Prompt Slot 与压缩恢复
└─ types.ts
```

工具名称也应描述真实动作：`EnterPlanMode` 可以只是请求进入；退出阶段更适合 `SubmitPlan`，因为模型提交后仍需用户批准，不能叫一个看似已经成功的 `ExitPlanMode`。

### 与第 01～09 章复核

- Plan Controller 是 TurnRuntime 的受控子状态，不创建另一套 Agent Engine。
- Plan Prompt 通过 Context Slot 注入，Tool Snapshot 通过 Tool Registry 收窄，安全事实不只靠提示词提醒。
- Plan 审批走根 Session 的交互队列，但与普通 Tool Permission 使用不同的结构化卡片和决策语义。
- Explore/Design 可复用 AgentRun 和 Turn Budget；Subagent 不能直接 AskUser 或批准自身计划。
- Skill 可以建议进入 Plan，但不能自行更改 PlanState 或放宽只读工具集。

---

## 11 Permission and Security：审批不是沙箱，信任必须纵深防御

> 源文档文件名为 `11-permission-security.md`，正文标题沿用了“第 12 章”；本评审按文件顺序记为 11。

### Claude 的业务与架构

Claude 使用纵深防御：工作区信任、Permission Mode、allow/ask/deny 规则、Bash 静态检查、工具领域校验、OS Sandbox、用户确认和可选分类器彼此独立。`bypass` 也不能越过 deny 与 bypass-immune 安全检查。审批输入、规范路径与实际执行目标必须一致；用户交互优先于自动分类结果。

### Ema 当前事实

Ema 已经建立了较强的 V1 安全边界：

- Permission 只有 ask/auto/bypass，bypass 标记为开发测试用途；
- 规则有 allow/deny/ask 与 session/project/global 作用域，使用稳定 Tool ID；
- safetyCheck、路径语法、UNC/NTFS/设备名、危险文件、原路径和 symlink/最近存在父目录解析都在自动允许前检查；
- deny/ask 高于 Session Grant，`allow_session` 按 Session 隔离；
- 用户等待期间重新解析路径，目标变化则拒绝；
- 没有 Ask callback 的 headless 场景直接 deny，不永久挂起；
- Pending Permission 保留 promptId/sessionId/turnId/toolCallId，支持 UI 重连恢复；
- Sandbox 是独立 package，Linux 使用 bubblewrap、macOS 使用 sandbox-exec，无法提供 OS 隔离时降级为 app-layer；
- Core 在 app-layer 时把 Bash/PowerShell 从模型可见 Tool Registry 移除，没有把“用户批准”伪装成“已隔离”。

仍需关注：Windows 裸机没有等价强 Sandbox；`CommandRunner` 的 background 分支直接 detached + unref 并立刻返回成功，无法追踪真实终态；project 规则/Hook 等未来来源尚无完整 Workspace Trust；“替我审批”的 LLM 分类器只在产品设想中，不应与当前静态 auto 模式混淆。

### Diff 判断

1. **V1 已对齐：Permission 与 Sandbox 继续物理分层。** Permission 回答“用户是否同意”，Sandbox 回答“进程实际能做什么”；任一层缺失都不能用另一层补名义安全。
2. **V1 必做：Windows app-layer 时继续隐藏 Shell 工具。** 可以向用户解释平台限制并允许开发者显式开启不安全模式，但正式 V1 不默认暴露裸 Bash/PowerShell。
3. **V1 必做：生产入口不能启用 bypass。** 环境变量或测试构造器可保留；Release build/Settings UI 不向普通用户提供绕过全部审批的开关，且 deny/bypass-immune 永远先生效。
4. **V1 必做：审批使用 PreparedToolCall 的稳定摘要与规范目标。** 等待期间任何参数、Registry 实现、symlink 解析或能力快照变化都要求重新 Prepare/审批，不能复用旧 promptId。
5. **V1 必做：每 Session Permission FIFO，跨 Session 独立。** Session A 等待审批时其 Turn 保持等待；Session B 可以继续。响应必须按全局 promptId 定位，不能按当前页面或工具名猜。
6. **V1 收口：权限卡向非开发者提供结构化解释。** Tool 自己产生确定性摘要（要读/改/执行什么、在哪、风险和影响）；右上角可在未来按需调用 LLM 做人话解释，但 LLM 文本永不参与实际裁决。
7. **V1 必做：后台 Shell 不能 detached 后立刻报告成功。** V1 要么禁用 `run_in_background`，要么返回受管理的 ProcessRunId，持续记录 PID、stdout 上限、取消与真实终态；父 Turn/应用退出时必须收口。
8. **V1 收口：Workspace Trust 与项目配置同时落地。** 只有用户信任某工作区后，项目级 Permission、Skill/Hook 配置才可启用；Profile 全局设置不能被仓库内容覆盖到敏感路径。
9. **V1 收口：受保护路径来自 RuntimePaths/Capability。** Permission/Sandbox 不自行猜 credential、profile.db、data.db、Sidecar 私有目录；Composition Root 明确注入规范路径集合。
10. **V1.5 候选：替我审批分类器。** 它使用单独 Binding 或当前模型 fallback，只能建议 allow/deny；用户一旦操作卡片，分类结果作废。危险/未知/外部路径默认不能自动批准，并保留完整 DecisionReason。
11. **V1.5 候选：Plan/无人值守模式。** Plan 使用只读 Tool Snapshot；未来 CLI 自动化可增加 dontAsk（ask 转 deny），但不复用 Desktop UI 的等待机制。
12. **不照搬：Claude 的企业策略来源数量和 coding 专用危险表。** Ema 先维护真实产品需要的 global/project/session 三层和跨平台保护，再按企业版需求增加 managed policy。

### 建议边界

```text
src/permission/                 Ema 产品规则、Prompt 队列、决策解释
packages/sandbox/              跨平台隔离与受管理进程技术底座
packages/system/               平台检测、路径与能力探测
src/tools/execution/           Prepared -> Permission -> Sandbox 调度
apps/desktop-ui/               权限卡与 Session 队列展示
```

当前 Permission 是 Ema Tool 产品安全策略，最终更适合根 `src/permission`；Sandbox 可以脱离 Ema 复用，保留在 packages。两者不应为了放到同一目录而合并。

### 与第 04～10 章复核

- Tool Registry 冻结调用，Permission 只裁决它，Sandbox 只执行它；三层针对同一份输入。
- FileEdit 原子提交前的乐观并发校验是 Permission 之后的最后一致性防线。
- Hook 不能覆盖 deny 或伪造 Sandbox；未来用户 Hook 本身也必须先经过 Workspace Trust。
- Subagent 没有 AskUser，不把 Permission 弹窗卡在后台；其工具集默认更窄，需审批的动作由父侧承担或直接拒绝。
- Skill `allowed-tools`、Plan 只读 Tool Snapshot 与 Permission 都是交集收窄关系，不是相互授权。

---

## 12 User Experience：可观察的自主性与桌面事件投影

> 源文档文件名为 `12-user-experience.md`，正文标题沿用了“第 14 章”；本评审按文件顺序记为 12。

### Claude 的业务与架构

Claude 的核心 UX 原则是“可观察的自主性”：尽量少打断，但模型、Tool、重试、错误、Usage 和后台工作必须实时可见且可中断。终端实现通过结构化流、增量 Markdown、Tool 进度、Diff、Permission 卡、虚拟列表和会话恢复把 Agent 的内部状态投影给用户。

其 Ink/ANSI 渲染器、Vim 编辑和终端协议是 CLI 专属实现；真正可迁移的原则是事件驱动、即时反馈、稳定状态机、权限防误触、自动恢复可见但不过度打扰，以及历史数据与流式临时状态分离。

### Ema 当前事实

Ema Desktop 已经具备不少对应组件：

- 前端消费结构化 SSE，不需要解析 Provider 原始流；
- `ToolCallBlock` 展示 running/awaiting_permission/success/failed/denied、参数、结果、耗时和单 Tool Abort；
- 文件工具可接收真实 `FileChangePresentation` Diff；
- Session Sidebar 展示流式和待处理问题数量，用户切到其他 Session 也能看到 A 正在等待；
- Decision Store/Permission/AskUser 已能按 Session 保存 Pending 项；
- Provider、Skill、Memory、Storage、Theme 等已有独立 Settings UI；
- Chat 页面仍存在旧 chat/narrative/agent mode、旧 TaskPanel 与多套 Store/事件投影；
- 工具参数展示由前端 `switch(name)` 解释，未知 MCP 工具退回平铺对象，跨端 Presentation 协议还不完整。

### Diff 判断

1. **V1 必做：前端围绕 Turn 投影，不围绕 `/chat` 请求状态。** 每个 Session 独立维护 activeTurn、stream slices、pending decisions 和 draft；一个 Session 的健康轮询、历史刷新或流重连不能清空另一个 Session 或当前输入框。
2. **V1 必做：Permission/AskUser 卡固定在输入框上方。** 它是会话内独立 UI Block，不是全屏居中弹窗；卡片紧凑，说明动作、目标、风险与影响，决策按钮靠右。Session 内 FIFO，一次只处理队首。
3. **V1 必做：非开发者先看人话，开发者可展开原始参数。** 后端 ToolPresentation 提供确定性摘要；未来右上角可按需调用 LLM 翻译，但原命令、路径、Diff 与风险事实始终可展开核对。
4. **V1 必做：Chat/Work 是唯一顶层 Profile。** 同一 Session 可切换，Turn 保存当时 Profile；NarrativePolicy 是 Chat 下二级控制，Narrative Recall 用专属 Block 展示，不再是第三模式。
5. **V1 必做：持久历史与临时流状态可重建。** 重开软件先加载 Session/Message/Turn 终态，再加载 pending Permission/AskUser/AgentRun；SSE 重连只补活动事件，不用“清空后重放”造成闪烁或草稿丢失。
6. **V1 收口：错误按用户动作分类。** 自动重试/降级显示轻量状态；需要换模型、补 Key、批准权限或重新上传附件时给明确按钮；不能把 Provider body、堆栈或 `fetch failed` 直接扔给普通用户。
7. **V1 收口：Tool 与 AgentRun 状态使用结构化 Reducer。** 事件可以重复或乱序到达时依赖 callId/runId/version 幂等合并；不能靠数组最后一项或工具名称判断当前状态。
8. **V1 必做：旧 TaskPanel 按领域拆 UI。** AgentRuns 面板展示子 Agent 执行；V1 TaskList 展示工作项；两者不继续共用“任务”卡片造成运行状态与工作项状态混淆。
9. **V1 收口：流式 Markdown 只重算不稳定尾部。** 长会话需要虚拟列表/稳定块 memo，用户自定义正文字体走 Theme/Settings Token；代码字体与角色聊天正文字体分开。
10. **V1 已收口：会话历史保持线性。** Ema 不继续维护同 Session Branch 树。侧栏 Fork 完整复制 Session；回复下 Fork 按 Turn 截止复制为独立 Session；用户消息只允许回滚最后一轮后重发。任意历史删除与 `<N/M>` 兄弟导航已移除，因为 Tool、Task、AgentRun 和外部副作用无法随一棵消息树可靠回滚。Codex 的 Worktree Fork 属于代码工作区隔离，不等同于 Ema 的会话内 Branch。
10. **V1 收口：Live2D/Emotion/TTS 是消费事件的表现层。** 动画、语音或模型资源失败不能阻塞 Turn 文本主链；窗口隐藏/失焦时暂停无意义动画，并尊重 reduced motion。
11. **V1 收口：所有样式复用 styles 与 `@ema-agent/ui`。** CSS Variable、动画、Button/Dialog 不在业务组件中另起体系；展开和收起都有统一动画。
12. **V1.5 候选：跨端 Presentation Adapter。** Desktop、未来 CLI/Web/移动端消费相同 Turn/Tool/Decision 协议，各自渲染；不把 ReactNode 放进后端 Tool 接口。
13. **不照搬：Ink 渲染器、终端对象池、Vim 模式和 ANSI 协议。** Ema 使用浏览器/Tauri 渲染能力，只借鉴增量更新与可观察性原则。

### 建议前端数据边界

```text
apps/desktop-ui/src/
├─ features/turns/             Turn command、active state、event reducer
├─ features/messages/          持久历史与虚拟列表
├─ features/tools/             Tool Block、Diff、Presentation adapters
├─ features/decisions/         Permission/AskUser FIFO 卡片
├─ features/agentRuns/         Subagent 执行状态
├─ features/tasks/             V1 结构化 TaskList
├─ features/narrative/         Recall 专属 Block
├─ features/composer/          Session draft、附件索引、Profile
├─ stores/                     只放跨 feature 的规范状态
└─ styles/                     Token、动画、主题与字体
```

这不是要求立刻机械搬目录，而是规定状态所有权：组件不直接 fetch 并维护第二份 Server State；API 层只收发协议；Store/Reducer 以 SessionId 和稳定运行 ID 归一化。

### 与前面章节复核

- TurnRuntime 的 `EmaStreamEvent` 是 UI 唯一实时输入；Context/Provider 内部对象不直接泄露。
- ToolPresentation 来自真实执行结果；Permission 卡展示 Prepared Call，不能由前端重新解释后再提交不同参数。
- AgentRun、Task、Plan 各用不同 UI；Pending Prompt 与 Turn 终态严格联动。
- Settings 只控制用户可理解的产品参数；底层安全硬限制不因 UI 开关而消失。
- Session A 等待确认时，切到 Session B 不会解决或取消 A；Sidebar 保留明显但不过度打扰的待处理标记。

---

## 13 Minimal Components：保留本质复杂性，拒绝空架构层

> 源文档文件名为 `13-minimal-components.md`，正文标题沿用了“第 15 章”；本评审按文件顺序记为 13。

### Claude 的业务与架构

本章用最小 coding agent 反推生产复杂度，指出 Prompt、Tool Registry、Agent Loop、文件/编辑、Shell 和交互是本质组件；MCP、Memory、Skill、复杂 UI 等只有在真实产品需要时才加入。重点不是生产系统应该只有 1300 行，而是每一层复杂度都必须能回答“解决了哪个已发生的问题”。

### Ema 当前事实

Ema 不是最小 coding agent。角色表达、Live2D、Memory、Knowledge Base、Narrative、语音和多 Provider 是产品定位，不属于可随意删除的偶然复杂性。但当前仓库确实存在两类不必要复杂度：

- 产品模块长期散在 packages，`contracts` 成为中央类型杂物箱；
- `apps/core` 的 route、orchestrator、wiring 和大型 `AppBindings` 同时承担协议、装配和业务选择；
- Chat/Narrative/Agent 三 Engine 或模式重复主链；
- AgentTask、Task、AgentRun、Job 等名字混用；
- 一些模块为了“有公共入口”使用 Facade/Manager/Service，而非表达真实职责；
- 同一业务既有 Hook 注入、Engine 拼接，又有 Context/Prompt 包，产生多处事实源。

### Ema 的最小产品骨架

对 Ema 来说，真正不可少的主骨架应收敛为：

```text
1. Turn Runtime          用户交互生命周期与唯一终态
2. Agent Loop            LLM/Tool 迭代与恢复
3. Prompt + Context      本次模型可见输入、预算与压缩
4. Model Capabilities    Provider 控制面 + 各模态执行面
5. Tool Safety           Registry + Permission + Sandbox
6. Session Persistence   Session/Turn/Message 与恢复
7. Event Protocol        Desktop/CLI/Web 可消费的结构化事件
8. Product Capabilities  Character/Memory/KB/Narrative/Voice，按明确端口接入
9. Host/UI               Tauri、Sidecar、Bridge 和桌面表现层
```

第 8 项虽然不是通用 Agent 的必要条件，却是 Ema 产品的必要能力；它们不应被塞入 Agent Loop 内核，也不应为了“最小化”删除。

### Diff 判断

1. **V1 必做：统一主链，保留产品能力插件式接入。** Chat/Work、Narrative、Memory、Skill 不各自拥有模型循环；它们提供 Profile、Context Contribution 或 Tool。
2. **V1 必做：`apps/core` 只做 Composition Root 与 BFF。** Route 解析/校验/认证/编码 SSE；wiring 构造模块公共入口；业务决策进入根 `src`，不再增加传统 `services/` 杂物目录。
3. **V1 必做：产品源码迁入根 `src`，技术底座留 packages。** “被两处引用”不是 package 理由；Storage 的 Ema Schema、Tool、Permission、Memory、Skill 等最终属于产品源码。
4. **V1 收口：公共入口按职责命名。** `LlmRouter`、`ContextAssembler`、`ToolRegistry`、`PermissionEngine`、`AgentRunStore` 已经足够；只有确实协调多个子系统且隐藏复杂性时才使用 Facade。
5. **V1 收口：不要建立 application/domain/infrastructure 三层模板。** Ema 按业务模块垂直组织，模块内部再按需要拆 Runtime/Repo/Adapter。Route 不承载业务并不等于必须新增一个全局 Service Layer。
6. **V1 收口：复杂文件按内聚职责拆，不追求一文件一类型。** `atomicWrite/recovery` 等有独立安全职责应拆；几行 types/helper 不为形式新建目录。`types.ts/errors.ts/index.ts` 不强制首行注释。
7. **V1 收口：删除兼容层要以生产引用归零为准。** 开发期可以删除过时测试和旧适配器，但不能只因新目录存在就宣布迁移完成；先 `rg`、构建直接消费者、跑主要入口，再删旧路径。
8. **V1.5 候选：CLI/Web/移动端只复用命令和事件协议。** 不为了未来入口提前抽象 UI 基类、通用 Controller 或传输无关数据库；先保证 Turn Runtime 不依赖 Desktop。
9. **不照搬：最小 coding agent 的功能删减。** Ema 的角色、Narrative 与长期 Memory 是差异化主体，不是可选 demo feature。

### 目标目录原则

```text
src/                         Ema 如何工作
├─ agent/ turn/ context/ prompts/ tools/ permission/
├─ sessions/ storage/ providers/ llm/ embed/ rerank/ vision/ stt/ tts/
├─ memory/ knowledge/ narrative/ skills/ mcp/ marketplace/
├─ characters/ emotion/ usage/ settings/ attachments/
└─ ...

apps/                        进程和交付入口
├─ core/                     Sidecar BFF + Composition Root
├─ bridge/                   Python-only compute
├─ desktop/                  Tauri Host
└─ desktop-ui/               WebView UI

packages/                    可脱离 Ema 复用的技术底座
├─ public-http/ credential/ sandbox/ system/
└─ ui/ live2d-react/
```

这是一张所有权图，不要求一次性全仓搬完。每次只做一个模块的行为保持迁移，再做业务收口，避免目录移动、Schema 和 Runtime 同批爆炸。

### 与前面章节复核

- 01～02 的 TurnRuntime/TurnLoop 是唯一核心，不再新增 ConversationEngine、SkillEngine 或 NarrativeEngine。
- 03～12 的模块都通过明确的输入输出接入主链，而不是被一个全局 Context/AppBindings 任意访问。
- `contracts` 拆除后，各模块拥有自己的 ID/事件/错误，Turn 只组合跨端事件联合。
- 安全技术底座保留 packages，不因为其他产品模块迁 src 就把 Sandbox/Public HTTP 也强行产品化。

---

## 14 System Prompt Design：显式 Slot，而不是继续拼一条巨型字符串

> 源文档文件名为 `14-system-prompt-design.md`，正文标题沿用了“第 13 章”；本评审按文件名记为 14。

### Claude 的业务与架构

Claude Code 没有把所有上下文混成一段字符串。它的提示体系至少有四层：

1. 七段稳定的主系统规则组成可跨会话缓存的静态前缀；
2. 会话指导、Memory、环境、语言、输出风格和 MCP 指令组成动态尾部；
3. 每个 Tool 自己携带完整 description 与 JSON Schema，不靠主 Prompt 复述参数；
4. Explore、Plan、Verification、Coordinator 等 Agent 使用独立 Prompt，并以真实 Tool Allowlist/隔离能力约束执行。

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的真正价值是稳定顺序和缓存身份，而不只是少拼几次字符串。章节中的 Tool Prompt 还反复证明：模型看到的说明必须与实际能力一致，例如只读 Agent 不能得到 Write，Plan 未启用就不能声明 EnterPlanMode，后台运行不能把“已启动”描述成“已完成”。

### Ema 当前事实

- `src/prompts/build.ts` 已成为旧 Engine 的兼容入口，内部开始使用 `PromptAssembler`；Character 模块产出 Identity 与 Presentation，Prompt 不再拥有 ACT 文案；
- `src/prompts/mode-blocks.ts` 仍声明旧 `chat/narrative/agent` 三模式，甚至规定 Chat/Narrative 不调用工具，与目标 Chat/Work + NarrativePolicy 冲突；
- `src/prompts/hooks.ts` 在 `beforeLlm` 中直接替换首条 system message，依赖 Hook priority 与 Memory/Narrative 的注册顺序；
- `src/context/promptPrefix.ts` 已经能规范化 Tool Manifest、计算 cache breakpoint 前缀 Hash，这是可保留的正确基础；
- Compaction 仍按旧 TurnMode 生成三套摘要和恢复块，说明 Profile 迁移不能只改前端枚举；
- Tool description 分散在各 Tool，方向正确，但尚未形成“注册即决定模型可见 manifest”的单一快照；
- Character Prompt 已开始使用明确 Slot 与 trust；Memory Recall、Narrative Recall 与 Hook 结果仍未迁入类型化 Context Contribution。

### Diff 判断

1. **V1 必做：建立 `PromptAssembler`，但 Context 保持最终所有权。** Prompt 模块只产出有序 `PromptSlot[]`；`ContextAssembler` 将 Slot、历史、Recall、当前输入和 Tool Manifest 组成本次模型请求。Prompt 不自行调 LLM，Context 不重新生成角色文案。
2. **V1 必做：Slot 使用明确字段。** 至少包含 `id`、`kind`、`order`、`content`、`version`、`cacheScope`、`trust`；不得使用 `meta` 或调用方猜 JSON。重复 `id` 应报错，不能静默覆盖。
3. **V1 必做：固定前缀与动态尾部显式分界。** 全局安全/行为规则、稳定 Tool 使用规则在前；启用的 Skill/MCP 摘要、ExecutionProfile、Character 在中段；环境、Recall、附件说明和当前 Turn 在尾部。具体缓存断点由组装器根据 Provider 能力投影，不由任意 Hook 塞 `cacheBreakpoint`。
4. **V1 必做：删除旧三模式 Prompt 语义。** 顶层只剩 Chat/Work；Character 在两者中始终存在。NarrativePolicy 控制是否检索，不创建 narrative 系统人格；`off` 仅提示可能缺失剧情细节。Compaction/restore 同步按新 Profile 迁移。
5. **V1 必做：Tool Schema 与文字说明同源。** Tool 注册后产出不可变 manifest snapshot；模型看到、Permission 审批、真正执行的都是该 snapshot 中同一个 Tool 与版本。主 Prompt 只说明通用选用原则，不复制每个参数表。
6. **V1 必做：不可信数据不能升级成系统指令。** Tool Result、KB、Narrative、附件和网页内容使用 `trust: 'untrusted-data'` 的 Context Contribution；即便内容包含 `<system-reminder>` 一类标签，也不能取得 System Slot 权限。
7. **V1 收口：每次 Turn 保存 Prompt/Tool 版本身份。** 持久化 `promptRevision`、`toolManifestRevision` 和 `prefixHash` 等明确字段，足够复现“模型当时看到了什么版本”；不必默认保存整份巨大 Prompt 副本。
8. **V1 收口：角色变化不应破坏真正固定的前缀。** Character Slot 放在全局稳定规则之后；同一 Session 内保持角色版本稳定，换角色后自然形成新的前缀身份。ACT 协议属于 Character Presentation Slot，不混进全局安全规则。
9. **V1 收口：Skill/MCP 渐进披露。** 固定前缀只放可用能力摘要，只有选中后才加载完整 Skill 文本或 MCP schema；连接状态变化放动态区域，不能迫使所有静态规则失去缓存。
10. **V1 收口：Prompt 不能承诺不存在的能力。** Plan、Team、Schedule、Artifact、强 Sandbox 或后台 Agent 未接线时，不注册对应 Tool，也不在文字中声称可用。Feature Gate 必须同时控制实现、manifest 和 UI。
11. **V1 收口：模型/协议差异在 Adapter 投影。** 通用 Slot 不绑定 Anthropic XML、OpenAI role 或 Gemini part；Protocol Adapter 负责序列化。Think Block 不回放给下一模型，媒体兼容由 RequestPreparer 在组装完成后、发送前执行。
12. **V1 收口：测试验证顺序与身份，不复制 Claude 的全文。** 应覆盖 Slot 唯一性、确定性排序、静态 Hash、动态尾部不污染固定前缀、Feature Gate 与 Tool Manifest 一致、非可信数据无法提升权限。
13. **V1.5 候选：专用 Agent Prompt Registry。** Explore/Plan/Verification 等只有在真实 Agent type 和 Tool Policy 落地后再注册；Prompt 中写“只读”不能代替物理 Tool Allowlist 与 Sandbox。
14. **不照搬：Claude Code 的 coding-only 长 Prompt、Coordinator、Worktree、Cron 和 Team 文案。** Ema 面向普通用户和角色交互，只复用分层、缓存、能力一致性和安全原则。

### 建议的数据流与文件边界

```text
src/prompts/
├─ promptAssembler.ts         收集、校验并稳定排序 PromptSlot
├─ productRules.ts            Ema 固定行为与安全边界
├─ executionProfile.ts        Chat/Work + NarrativePolicy
└─ types.ts                   PromptSlot、CacheScope、PromptTrust

src/characters/
└─ characterPrompt.ts         Character Identity + Presentation；组合角色词表与 ACT 模型说明

src/emotion/                  ACT 流式解析、状态转换与 StageCue
packages/live2d-react/        将 StageCue 映射为具体 Live2D 表情和动作

ContextAssembler
  ← PromptAssembler.build(snapshot)
  ← Memory/Narrative/KB ContextContribution
  ← Session history + current Turn
  ← ToolRegistry.manifestSnapshot()
  → RequestPreparer（模型能力与媒体兼容）
  → LlmRouter（协议投影与调用）
```

不建议把每个两三行 Slot 都拆成文件；上图表达所有权，实际按内容规模合并。Hook 可以通知或贡献明确 Slot，但不再允许 `beforeLlm` 任意替换整份 messages。

### 与前面章节复核

- 与 03 一致：Prompt 定义语义，Context 决定最终窗口、预算、压缩与发送顺序。
- 与 04/11 一致：Tool description、PreparedToolCall、Permission 与执行共享同一 manifest 身份；文字约束不是安全边界。
- 与 06 一致：Hook 使用类型化 Contribution，不接管主消息数组。
- 与 08/09 一致：Memory、Skill 和 MCP 都在固定前缀之后渐进注入，不能彼此覆盖。
- 与 10 一致：Plan 是未来 Work 子状态，未注册前 Prompt 不得声称存在。
- 与 12 一致：前端显示的 Profile、Tool 和决策能力必须来自同一运行时快照，不能只改文案。
- 与 13 一致：只新增一个真实组装边界，不再建立 PromptManager、PromptService、PromptFacade 三层空壳。

---

## 15 Task System：工作清单不是 Agent 运行记录，也不是后台 Job

> 源文档文件名为 `15-task-system.md`，正文标题沿用了“第 11 章”；本评审按文件名记为 15。

### Claude 的业务与架构

Claude 的 Task 是模型和用户都能看见的结构化工作清单：`subject/description/activeForm/status/owner/blocks/blockedBy`。它通过 TaskCreate/Get/List/Update 管理工作分解，通过细粒度锁和原子认领支持 Team/Swarm，通过工具结果与低频提醒让模型保持任务意识。这里的 owner 是稳定、可寻址的 teammate name，不是一次普通 Subagent Run；普通 AgentTool 子级并不获得四个 Task Tools。Task 完成也不等于某个进程退出。

### Ema 当前事实

- 旧 `src/tasks`、根 Turn 的 AgentTask 投影和 `AgentTurnLifecycleFacade` 已删除；Data v17 只把真实子执行迁入 `agent_runs/agent_run_messages`；
- AgentRun 已拥有独立 branded ID、CAS 终态、崩溃恢复、可选 TaskId、执行统计与 transcript；Tool Journal 同时记录父 Turn 和可选 AgentRun，不再拿 Run ID 冒充 Turn ID；
- 旧内存 `TodoWriteTool` 已停止注册并删除，根 Work Turn 只暴露持久 TaskCreate/Get/List/Update；
- 前端 `TaskPanel` 仍展示 AgentRun transcript，旧 `/api/agent-tasks` 与 SSE `subagentId` 仅是迁移期兼容，名称仍容易让人误解为待办清单；
- KB ingest、Memory extraction、Vision、Embedding 等另有自己的任务表和 lease/recovery，它们是领域 Job，不是用户工作项；
- Data v18、TaskStore、依赖/CAS、AgentRun 可选绑定、结构化事件、低频 Context 提醒、REST 重启快照和备份恢复已经完成；普通 Subagent 不获得四个 Task Tools；
- 独立前端 TaskList 尚未实现，现有 TaskPanel 仍是 AgentRun transcript 的迁移期旧名。

### Diff 判断

1. **V1 已完成：后端 AgentRun 语义拆分。** 表、Repo、Store、Spawner、Tool Journal、备份和 Core 新 API 已使用 AgentRun；根 Turn 不再复制运行记录。前端面板、旧 API 路径与 SSE 字段名仍是明确的下一批迁移边界。
2. **V1 已完成：`src/tasks` 实现完整结构化工作项。** Task 使用显式列/类型：稳定 `taskId`、Session 内 `displayNumber`、`sessionId`、`subject`、`description`、`activeForm`、`status`、`version` 与时间字段；依赖使用明确关系表，不用 metadata JSON。V1 不保存 `ownerAgentRunId`，因为根 Agent 可以直接执行工作，而一次性 Run 不是长期 owner。
3. **V1 后端已完成：TaskCreate/Get/List/Update 替换 TodoWrite。** 四个 Tool、TaskStore、事件、Context 提醒和恢复快照已接线，旧内存 TodoWrite 已删除；剩余工作是独立前端 TaskList。
4. **V1 已完成：AgentRun 可绑定 Task，但两者生命周期独立。** 一个 Task 可以被不同 AgentRun 先后重试，一个 AgentRun 也可能执行没有 Task 的临时研究。活动绑定通过 `agent_runs.task_id` 投影并限制同一 Task 同时最多一个活动 Run；AgentRun 成功不能自动把关联 Task 标完成，必须由根循环显式提交。
5. **V1 必做：Job 不继承 Task。** KB Job 可调用 Vision/Embedding 子步骤，Vision Job 也可独立运行；它们各自维护 lease、checkpoint、幂等和恢复，只在确需向用户展示工作目标时关联可选 TaskId。
6. **V1 已完成：并发写使用 SQLite 事务 + CAS。** Ema 不照搬“一任务一 JSON 文件 + fs.watch”；创建、依赖更新和完成使用事务，`version` 防陈旧写，活动 Run 绑定由数据库约束保证。
7. **V1 部分完成：前端事件驱动，重启后以 DB 重建。** Task 结构化事件和 `/api/tasks` 快照已经提供；独立 TaskList 尚未消费它们。Task 面板与 AgentRun transcript 面板必须分开。
8. **V1 已完成：Task 提醒作为动态 Context Contribution。** 只在 Work 清单存在且长时间未更新时低频注入，不写入固定 System Prompt；提醒携带真实 Task version，避免缓存失效和陈旧状态。
9. **V1 收口：AskUser/Permission 不属于 Task 状态。** 等待用户时 AgentRun 进入 waiting，Prompt 独立持久化；Task 保持 `in_progress`，是否被阻塞由依赖关系投影，不增加 `waiting_user` 或 `blocked` 持久状态，也不存 pendingPromptId。
10. **V1 已完成：依赖与 AgentRun 活动绑定进入 Task 闭环。** `blockedBy/blocks` 由关系表和事务维护；启动 AgentRun 时验证同 Session、未终态、依赖已完成且无其他活动 Run。Run 终态后 Task 成为“无活动执行者”的待处理项，根 Agent 决定重试、继续、取消或完成。Team owner、跨设备领取、复杂忙碌调度与实验性验证 nudge 仍属 V1.5。
11. **V1 已完成：四个 Task Tools 不下放给普通 Subagent。** 根 Turn 负责拆分、依赖、状态与最终验收；子 Agent 只执行启动时给定的自包含任务，并通过 AgentRun 结果汇报。未来 Team 成立后，才允许可寻址 teammate 自主 `TaskList/TaskUpdate`。
12. **不照搬：Claude 的递增短 ID、文件锁、高水位与团队目录。** Ema 内部保持全局稳定 UUID；UI 可以额外显示 session 内短序号，但短序号不能成为外键。

### V1 数据与 Tool 契约

```ts
type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface Task {
  id: TaskId;
  sessionId: SessionId;
  displayNumber: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  createdByTurnId: TurnId;
  completedByTurnId?: TurnId;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

`task_dependencies(blocker_task_id, blocked_task_id)` 维护依赖，两个外键必须属于同一 Session，添加依赖时拒绝自环和已经可证明的环。一次 Task 的历史尝试由 `agent_runs.task_id` 保留；对活动状态建立唯一约束，避免同一 Task 被两个子 Agent 同时执行。Task 快照可以投影 `activeAgentRunId`，但它不是 Task 的持久 owner 字段。

四个模型 Tool 使用稳定职责：`TaskCreate(subject, description, activeForm?)`、`TaskGet(taskId)`、`TaskList()`、`TaskUpdate(taskId, fields/action)`。它们只向根 Turn 注册；`TaskUpdate` 的删除/取消必须是显式 action；Get/List 只读，Create/Update 通过事务与 version 拒绝陈旧写。Tool 结果、Task 事件和 REST 快照共享同一个 Task mapper，不能形成三套字段。

Subagent Tool 使用另一套契约：输入可带既有 `taskId`，输出和后续控制使用新建的 `agentRunId`。Spawner 不创建 Task，也不把 Run 终态映射成 Task 终态。根循环收到 Run 结果后，再根据是否真正完成、验证是否通过和依赖是否解除决定调用 `TaskUpdate`。

### 建议所有权

```text
src/tasks/                    用户/模型可见工作清单
├─ taskStore.ts               SQLite 事务、CAS、依赖与活动 Run 校验
├─ protocol.ts                API/SSE 快照与事件
├─ taskContext.ts             低频动态 Context Contribution
└─ types.ts

src/builtinTools/tools/
├─ TaskCreateTool/
├─ TaskGetTool/
├─ TaskListTool/
└─ TaskUpdateTool/

src/agent/runs/               Agent 实际执行领域与状态机
├─ agentRunStore.ts           CAS 终态、查询与恢复
└─ types.ts                   AgentRun 领域契约

src/storage/repos/
├─ agent-runs.ts              AgentRun 原子 SQL
└─ agent-run-messages.ts      transcript 顺序写入

src/knowledge/jobs/           KB 领域 Job
src/vision/jobs/              Vision 领域 Job
src/memory/jobs/              Memory 领域 Job
```

### 与前面章节复核

- 与 02/07 一致：Turn 是根交互，AgentRun 是执行，Task 是工作项；三者 ID 不混用。
- 与 03/14 一致：Task snapshot 属于动态尾部，不破坏固定 Prompt 前缀。
- 与 06 一致：TaskCreated/Completed Hook 可以观察或阻止状态变更，但回滚由 TaskStore 事务保证。
- 与 10 一致：Plan 可以生成 Task 草案，批准后才创建/更新正式 Task；Plan 本身不是 Task。
- 与 12 一致：前端 TaskList 与 AgentRun Panel 分开，不再把 transcript 运行记录画成待办事项。
- 与 13 一致：不建立万能 task-runtime；共享的是少量生命周期原则，不是所有领域继承同一基类。

---

## 16 Observability：Usage、审计、运行事件和调试追踪必须分账

### Claude 的业务与架构

Claude 把可观测性分成四种用途：低基数 Metrics 负责聚合总账，Events 负责离散事实，Trace Span 负责父子耗时，Transcript 负责本地恢复与因果回放。它不会拿一个“大号 logger”同时解决四类查询；聚合层拒绝 promptId 等高基数身份，敏感正文默认不导出，等待用户批准和真实工具执行分别计时。

### Ema 当前事实

- `src/usage` 与 `usage_records` 已覆盖 LLM/Vision/Embed/Rerank/STT/TTS 的调用级账单，`UsageContext` 能携带 call/session/turn 身份；
- Turn 还有汇总 usage，Agent Loop 已用 snapshot delta 避免流式 Usage 重复累计；
- `TelemetryRepo` 是一个通用 kind/payload 事件表，已有保留上限与确定性排序，但缺少明确生产者、查询产品和隐私契约，属于此前讨论的半成品；
- `EmaStreamEvent` 同时承载用户界面事件、Memory 后台状态和一些 telemetry 命名事件，领域边界有混杂；
- AgentRun transcript、Tool execution journal、Turn/Message 已经能提供本地恢复证据，但尚无统一 correlation envelope 和因果父子字段；
- Permission 能拿到 promptId/toolCallId，却没有形成持久的审批来源审计账。

### Diff 判断

1. **V1 必做：保留 UsageRecords，明确它是账单而非 Telemetry。** 每次真实模型调用只写一条调用级记录，以 capability + callId 幂等；Turn usage 从调用记录汇总或在同一终态事务中投影，不能 fork 后重复计费。
2. **V1 必做：建立轻量本地 Audit/Event 边界。** 只记录需要复盘的离散事实：Turn 终态、模型调用结果、Tool prepare/decision/result、AskUser、AgentRun、Job 恢复。字段采用明确列/联合类型，不用任意 payload JSON 当产品协议。
3. **V1 必做：统一 correlation identity。** 事件按需携带 `sessionId/turnId/llmCallId/toolCallId/promptId/agentRunId/jobId`，缺哪个就不伪造；另有单调 `sequence` 表示发射顺序。父子因果使用明确 `parentEventId` 或领域引用，不靠 createdAt 猜。
4. **V1 必做：Permission 审计记录“为什么放行”。** 保存 decision、source（session grant/once/deny/policy/hook）、等待时长、prepared call hash 和时间；不保存解密后的 Key、完整敏感命令输出或 Provider body。
5. **V1 必做：观测失败绝不拖死主链。** Usage 的财务一致性按业务要求落库；普通调试事件 best-effort、有界保留、可禁用。不得因为 TelemetryRepo 写失败把 Turn 标失败。
6. **V1 收口：删除或改造通用 `TelemetryRepo`，不能保持半成品。** 若没有任何用户可见诊断入口和生产消费方，V1 删除其公开入口/空表；若保留，则改名为明确的 `DiagnosticEventRepo`，限定事件联合、retention 与查询目的。
7. **V1 收口：Transcript 用业务表重建，不复制 Claude JSONL。** Session/Turn/Message/ToolExecution/AgentRun 已是 SQLite 事实源；需要导出时流式投影为 JSONL/ZIP，不再并行写另一套不可事务化记录。
8. **V1 收口：本地诊断默认只记录形状。** 模型、协议、token、耗时、结果分类、大小可记录；Prompt、回复、Tool 参数/结果、文件内容和密钥默认不进入诊断事件。用户主动导出诊断包时再明确告知范围并脱敏。
9. **V1 收口：错误分类与事件共用模块错误码。** UI Event 是产品状态投影，Diagnostic Event 是调试证据，Usage 是账单；三者可以从同一事实扇出，但不能互相替代。
10. **V1.5 候选：内存 Span Tree 与可选 OTLP exporter。** 真有性能诊断需求时，用 AsyncLocalStorage 绑定 Turn 根 span，并发 LLM 显式持有自己的 span；外部导出必须 Settings 明示开启。V1 不引入完整 OTel 依赖。
11. **不照搬：Anthropic 内部分析、BigQuery 双管线和云团队 Metrics。** Ema 是本地单人应用，默认不向项目方上传行为数据；开源不改变用户数据默认留在本机的原则。

### 建议边界

```text
src/usage/                    可计费模型调用事实
src/turn/events.ts            前端可消费的产品事件
src/diagnostics/              可选、本地、有界、脱敏的调试事件
src/permission/audit.ts       安全决策审计
各领域 Store/Repo             可恢复事实源与 transcript
```

不要新建全局 `logger.ts` 让所有模块随意塞对象。普通运行日志仍可输出，但结构化持久数据必须先回答“谁查询、为何保存、保留多久、是否敏感”。

### 与前面章节复核

- 与 02 一致：Turn 是根相关身份；同一 Turn 内多次 LLM/Tool 使用各自 CallId。
- 与 04/11 一致：Prepared Call hash、批准来源和真实结果形成可审计链，批准不能与执行参数脱节。
- 与 07/15 一致：AgentRun/Task/Job 使用各自 ID，观测层只关联，不替它们管理生命周期。
- 与 14 一致：保存 Prompt revision/hash 足以定位版本，默认不复制完整系统 Prompt。
- 与 13 一致：不为“工业感”直接引入四套基础设施；V1 先完成本地事实、账单和安全审计。

---

## 17 Autonomy / Goal / Loop：完成条件与时间触发是两套业务

### Claude 的业务与架构

Claude 的 `/goal` 在每个 Turn 停止点调用独立判定器，根据 transcript 证据返回 achieved/not-yet/impossible；`/loop` 则由 Cron、Monitor 或 Wakeup 决定何时再次投递 Prompt。前者回答“什么时候算完成”，后者回答“什么时候再运行”，不能因为都跨 Turn 就合成一种 Task。

### Ema 当前事实

Ema V1 目前没有稳定的跨 Turn Goal、Cron 或自唤醒产品；已有的是单 Turn 内 Agent Loop、后台 AgentRun、领域 Job 和普通 Settings。它们能够长时间运行，但没有独立完成判定器，也没有在应用关闭后恢复自治循环的统一语义。

### Diff 判断

1. **V1 不实现 Goal/Schedule 产品。** 当前先保证一次 Turn 内的 loop 有 iteration/budget/cancel/terminal state；不能把 maxIterations 重试循环包装成跨 Turn Goal。
2. **V1 必须为以后保留身份边界。** Goal 至少需要 `goalId/sessionId/condition/status/evaluatorBinding/iterationCount/version`；Schedule 需要 `scheduleId/trigger/nextRunAt/timezone/enabled/version`。两者都只能关联 Turn，不复用 TurnId/TaskId。
3. **Goal 的完成判定必须独立且结构化。** 未来使用受约束输出的 evaluator，只读 transcript/evidence，不拥有 Tool；主 Agent 的“我完成了”只是证据，不是裁决。`impossible` 也需明确理由和用户可见终态。
4. **Schedule 只负责投递，不判断业务成功。** Cron/事件/应用启动唤醒创建新的 Turn command；Goal evaluator 决定是否还需下一轮。固定轮询不能代替 Worker 完成通知。
5. **本地桌面必须定义关机语义。** Session-only loop 可随应用退出终止；持久 Schedule 必须落 Profile DB，并由 Desktop Host/Sidecar 启动恢复。V1.5 实现前不在 Prompt/UI 声称“关闭软件仍会运行”。
6. **所有自治循环都要硬限制。** 最大迭代、token/金额/墙钟预算、退避、并发上限、权限策略和明确取消；Goal 不能扩张用户最初授权，Schedule 唤醒也不能继承一次性批准。
7. **V1.5 将 Goal 放 `src/goals`、Schedule 放 `src/schedules`。** 不命名为 tasks，也不放进 AgentRun；它们通过 Turn command 接入唯一 TurnRuntime。
8. **不照搬：Claude 云端 Schedule、KAIROS、Prompt 驱动的 cron 解析。** Ema 的 durable schedule 必须适配 Windows/macOS/Linux 的本地应用生命周期，时间解析结果在创建前向用户明确展示。

### 与前面章节复核

- 与 02/15 一致：一次 Goal 可产生多个 Turn；Task 是工作项，AgentRun 是执行，Schedule 是触发器。
- 与 11 一致：自治不会绕过 Permission/Sandbox；每次新 Turn 重新计算有效授权。
- 与 16 一致：Goal iteration 与 Schedule fire 使用结构化事件和 Usage，可回答跑了几轮、为何停止。
- 与 13 一致：现在只留接口身份，不提前建立通用自治 Runtime。

---

## 18 Auto Mode：自动审批不是 ExecutionProfile，也不是放弃 Sandbox

### Claude 的业务与架构

Claude Auto Mode 在静态 deny、命令分析、文件保护和 Sandbox 之后增加一个语义分类器，只处理原本需要问人的灰区。分类器看用户消息和真实 Tool Intent，却刻意不看 assistant 的辩护文字；先用低成本高召回粗筛，再对可疑动作精判。任何失败向人工确认或中止降级，hard deny 不允许用户意图覆盖。

### Ema 当前事实

Ema 已有 PermissionEngine、Session grant、PreparedToolCall、Ask UI 和 Sandbox 分层，但“替我审批”只记录为未来设想，尚无分类器 Binding、规则模型、审计与熔断。Chat/Work 是执行行为 Profile，不表达审批强度。

### Diff 判断

1. **V1 不做 LLM 自动审批。** 当前权限维持 allow/ask/deny + Session grant；UI 预留文字即可，不注册不存在的自动审批能力。
2. **命名必须分开。** `ExecutionProfile = chat | work`；未来权限策略可叫 `PermissionMode = ask | trusted | autoReview`。不得把 Work 等同于全自动放行。
3. **未来分类器只能插在硬规则之后。** 路径穿越、授权根目录、密钥、网络边界、hard deny 和 Sandbox 先执行；分类器只决定剩余动作是 allow 还是 ask，永远不能直接执行 Tool。
4. **分类输入使用 PreparedToolCall 快照。** 可见用户明确授权、持久项目规则、工具名/参数/目标和必要环境；不读取主模型 reasoning，也不接受 Tool Result/网页中的文字冒充授权。
5. **高风险授权证据门槛高，收紧边界门槛低。** “别 push/别删除”立即收紧；“你随便做/我信任你”不能授予无限权限。Hard deny 不被自然语言覆盖。
6. **分类器失败必须 fail-closed。** 超时、解析失败、上下文过长、连续拒绝或模型不可用时回到人工确认；无人值守场景直接暂停，不得静默 fail-open。
7. **未来 Binding 属于业务设置。** 可以在模型绑定中增加 `permission-review` 专用能力，未配置时不自动拿当前聊天模型冒充安全判定器；规则、模型版本和 decision source 都需审计。
8. **V1.5 先实现 deterministic human description，再评估分类器。** Tool 卡片的人话摘要可按需用 LLM 辅助，但摘要不参与安全判定，真实参数始终可展开。
9. **不照搬：Claude 的 YOLO/Auto 规则全集和远程 kill switch。** Ema 本地应用需要本地明确硬规则和 Settings；开源实现不能依赖开发者远程开关来修正安全错误。

### 与前面章节复核

- 与 04/11 一致：模型只给 Tool Intent，Prepared Call 冻结后才审批，Sandbox 最终执行。
- 与 12 一致：未来“替我审批”是 Permission 卡的辅助入口，不是隐藏执行结果。
- 与 16 一致：每次判定保存规则版本、模型、结果、来源和耗时，不保存主模型思考。
- 与 17 一致：Goal/Schedule 即使无人值守，也不会自动扩大 PermissionMode。

---

## 19 Dynamic Workflows：确定性编排可以复用 AgentRun，但不能替代 TurnRuntime

### Claude 的业务与架构

Dynamic Workflow 用受限、可重放的脚本确定 fan-out、pipeline/barrier、预算和收敛；每个 `agent()` 仍是普通子 Agent 原语。结构化输出让 stage 之间传对象而非正则解析文本，journal + 内容 hash 支持断点续跑，硬并发/总数/token 上限防失控。

### Ema 当前事实与 Diff

Ema V1 没有需要一次铺开数十 Agent 的成熟产品场景，且 AgentRun/Task/Job 的语义还在收口，因此不应现在新建 WorkflowEngine。不过当前重构必须保证未来能接：

1. **V1 不实现模型现写 JS 的 Workflow。** 普通 Work Turn 继续由 TurnLoop 按需生成少量 AgentRun；不向普通用户暴露脚本执行权限。
2. **AgentRun 公共入口必须可被未来 Orchestrator 调用。** 输入包含不可变 prompt、capability policy、budget、optional taskId、isolation；输出是 terminal result + usage，不能依赖 Desktop UI。
3. **结构化输出属于通用 LLM/Agent 能力。** 未来 workflow 可给 AgentRun 附加 output schema；校验失败是该 Run 失败，不返回“看起来像 JSON”的字符串。
4. **并发原语不做万能 Job 基类。** 未来 `src/workflows` 只协调 AgentRun；KB/Vision/Embedding Job 保持领域生命周期，需要时通过明确 adapter 作为 stage，而非伪装 Agent。
5. **断点续跑基于 step identity + journal。** 每步由规范化输入、能力版本和依赖结果计算 hash；完成结果可复用，running/unknown 在恢复时重新裁决。不得用 createdAt 或数组位置判断完成。
6. **pipeline 默认不设全局 barrier。** 独立 item 完成上一步即可前进；只有全量去重、合并或全局判断才 barrier。该原则也适用于 KB/Vision 批处理。
7. **预算与隔离由 Runtime 硬执行。** 并发、总 Run 数、token/费用、墙钟和取消信号不可只写在 Prompt；并行写文件未来需要 worktree 或写集合冲突控制。
8. **V1.5 候选目录为 `src/workflows`。** 它依赖 `src/agent/runs`、Tasks、Usage 和 Tool/Sandbox，不拥有 Session、Provider Adapter 或持久消息。
9. **不照搬：`ultracode` 关键词和 1000-agent 上限。** Ema 面向本地单机普通用户，规模限制应来自设备能力、用户 Settings 和产品场景，默认远低于 Claude 云端/CLI 编排。

### 与前面章节复核

- Workflow 是空间并行；17 的 Schedule 是时间触发；Goal 是停止裁判。
- Task 可描述 workflow 工作项，AgentRun 是实际 worker，Job 是领域后台步骤。
- Prompt Slot、Permission、Sandbox、Usage 和事件协议均复用现有公共入口，不创造第二条执行链。

---

## 20 Agent Teams：协作消息是输入，不是用户授权

### Claude 的业务与架构

Agent Teams 在共享 TaskList 之上增加成员、点对点消息和团队产出；它不同于主从式叶子 Subagent。最重要的安全规则是：另一个 Agent/会话的消息永远不等于本会话用户意图，不能解除 Permission；让别的会话代跑自己被拒的动作属于权限洗白。

### Ema 当前事实与 Diff

Ema V1 是单用户、单角色呈现，但未来可能多角色、多 Agent 和多入口。当前只有主 Agent→Subagent 的纵向关系，没有跨会话 peer 权威模型。

1. **V1 不实现 Team/Peer 网络。** 先把 AgentRun、Task 与 transcript 做对；不建立共享 Memory、跨机 bridge 或 Artifact 协作。
2. **现在就固定消息来源类型。** `MessageOrigin` 至少区分 `user`、`agentRun`、`hook`、`tool`、`externalChannel`；来源不是 user 的内容永远不能构成危险操作授权。
3. **未来 teammate 复用 TaskStore 与 AgentRun。** Team 只提供成员、寻址和消息，不新建 TeamTask；Task owner 使用稳定 `TeamMemberId`，实际执行仍以独立 AgentRun 关联，不能把一次 Run 当成员身份。
4. **多角色不等于多 Agent。** Character 是表现与 Prompt 身份；AgentMember 是执行主体。一个角色可由一个 Agent 呈现，也可只改变同一 TurnRuntime 的 Character Slot，不能用 characterId 当 agentRunId。
5. **QQ/微信/Web 等外部消息默认 untrusted input。** 它可以创建待用户处理的 Turn，但不能继承桌面用户的本地文件、push、发送或凭据授权；高后果动作回到可信 UI 确认。
6. **禁止跨 Agent 权限洗白。** A 被拒后把请求发给 B，B 仍按原动作重新检查，且 peer 请求不能作为 user approval。
7. **共享 Memory/产出未来必须有分区、版本和 secret filter。** 不能直接把当前全局 L0/L2 同步给所有角色或远端；Artifact V1 Feature Gate 保持关闭。
8. **V1.5 候选目录 `src/teams`。** 依赖 Tasks、AgentRun、Message Origin、Permission 与 Memory public ports，不拥有自己的模型循环。

### 与前面章节复核

- 与 07/15 一致：Team 是横向协作，AgentRun 是执行，Task 是共享工作项。
- 与 08 一致：长期 Memory 需要明确 audience/partition，不能因“同队”自动全量共享。
- 与 11/18 一致：只有真实用户渠道能提供授权，分类器也不能替跨信任边界消息放行。
- 与 16 一致：消息 origin、sender、关联 Run/Turn 和决策来源必须可审计。

---

## 21 Background Fleet：V1 需要可恢复后台 Run，不需要复制一台 daemon 舰队

### Claude 的业务与架构

Claude 把后台分成两层：会话内的后台 Subagent 由完成通知唤醒主循环；脱终端的整个 Session 则由按需 daemon 监管、独占 attach、崩溃重生、收养孤儿并处理平台差异。它不是简单 `spawn(detached)`，而是完整 supervisor。

### Ema 当前事实

Ema 是 Tauri Desktop + TS Sidecar + Python Bridge。Desktop Host 本来就是应用级 supervisor；AgentRun、Memory/KB/Vision Job 有各自部分恢复能力，但还没有统一的应用启动恢复审计。V1 明确不支持软件多开，也不需要终端 detach/attach 产品。

### Diff 判断

1. **V1 不实现 `/bg`、Fleet daemon 或多会话 attach。** Desktop Host 是唯一进程所有者，负责 Core/Bridge 启停与 readiness；不要在 TS 业务层再起第二台 supervisor。
2. **V1 必做：会话内后台 AgentRun 使用通知而非轮询。** 启动后返回 agentRunId；完成/失败/cancel 发送结构化事件唤醒对应 Session。主循环不 sleep-poll。
3. **V1 必做：应用重启执行恢复扫描。** running/waiting/outcome_unknown 的 AgentRun 和各领域 Job 按自己的 checkpoint/lease 判定 resume/retry/fail；不能把所有 running 一律继续，也不能无限占用。
4. **V1 必做：Sidecar/Bridge 生命周期归 Desktop RuntimeSupervisor。** PID/nonce/protocolVersion/readiness、进程树终止和资源路径按 Windows/macOS/Linux 实现；业务 Job 不直接管理子进程树。
5. **V1 必做：同一 Profile 单实例。** Desktop 获取 profile lock；第二次启动将窗口聚焦或明确提示。这样避免两个 Core 同时领取 Job、同时写 Profile DB 和重复恢复 AgentRun。
6. **V1 收口：AgentRun 状态与 OS 进程状态分开。** 进程活着不代表 Run 成功，进程死了也不等于业务必然失败；以 journal/checkpoint/terminal event 为事实。
7. **V1 收口：后台 Run 不自动获得外部副作用授权。** commit/push/发消息等仍走 Permission；Ema 不照搬 Claude 后台默认自动开 draft PR 的 coding 产品策略。
8. **V1.5 候选：Desktop 后台常驻/系统托盘。** 若用户需要关闭窗口后继续，可由 Tauri Host 明确保持应用运行并展示托盘状态；真正关应用时按策略暂停或取消，而不是偷偷遗留 detached process。
9. **跨平台是 RuntimeSupervisor 的硬要求。** Windows Job Object、macOS/Linux process group、App Bundle/AppImage/安装目录分别实现；不能假设 Git 根目录或本机 Bash 路径。

### 与前面章节复核

- 与 10 的 Worker 原则一致：CAS/lease/checkpoint/幂等和断电恢复属于每种 Run/Job 的共同语义，但不要求继承万能基类。
- 与 15 一致：AgentRun 是后台执行，Task 只是可选工作项；Job 可独立运行。
- 与 17/19 一致：未来 Schedule/Workflow 复用恢复与通知，不拥有进程 supervisor。
- 与 16 一致：spawn、resume、adopt、cancel、unknown outcome 都要留下诊断事件和 Usage 边界。

---

## Quick Start / Reference 交叉校验：全书结论如何落到 Ema

两份速查文档没有引入新子系统，但暴露了一个重要事实：Claude 的核心始终是受控 Agent Loop，Context、Tool、Permission、Memory、Skill、Multi-Agent 都围绕主循环提供输入或能力。Ema 的产品能力更多，但不应因此再长出平行 Engine。

### 最终依赖方向

```text
Desktop / future CLI / Web / channels
                 │ TurnCommand + EmaStreamEvent
                 ▼
             TurnRuntime
                 │
        ┌────────┴────────┐
        ▼                 ▼
     TurnLoop         Session/Turn Store
        │
        ├─ ContextAssembler
        │    ├─ PromptAssembler
        │    ├─ Memory RecallBundle
        │    ├─ Narrative/KB ContextContribution
        │    ├─ history + current input
        │    └─ ToolManifestSnapshot
        │
        ├─ LLM RequestPreparer → LlmRouter → Protocol Adapter
        │
        └─ Tool Preparation → Permission → Sandbox → Execution
                                   │
                                   └─ AgentRun / domain capability

横向事实：Usage、Audit/Diagnostics、Settings、Credential、Storage
未来编排：Task、Plan、Goal、Schedule、Workflow、Team 只调用上述公开入口
```

### 目标模块拆分

```text
src/
├─ turn/                 Turn command、runtime、跨端事件、唯一终态
├─ agent/                TurnLoop 与 AgentRun
├─ context/              模型窗口、预算、压缩、ContextContribution
├─ prompts/              PromptSlot 与稳定组装
├─ tools/                Registry、PreparedToolCall、执行与结果
├─ permission/           决策、Session grant、审计
├─ sessions/ storage/    Ema 数据模型、Repo、恢复
├─ providers/            Provider 控制面与模型 Catalog
├─ llm/ embed/ rerank/ vision/ stt/ tts/
├─ memory/ knowledge/ narrative/ characters/
├─ skills/ mcp/ marketplace/
├─ usage/ diagnostics/ settings/ attachments/
├─ tasks/                V1 若保留结构化工作清单
└─ goals/ schedules/ workflows/ teams/   V1.5，尚不创建空包

apps/
├─ core/                 Sidecar BFF + Composition Root
├─ bridge/               Python-only Narrative compute
├─ desktop/              Tauri Host + RuntimeSupervisor
└─ desktop-ui/           Turn/Tool/Decision 的桌面投影

packages/
├─ public-http/ credential/ sandbox/ system/
└─ ui/ live2d-react/     可脱离 Ema 的技术底座
```

### 建议迁移顺序

1. **先锁定语义和 ID。** ExecutionProfile、NarrativePolicy、Turn/Call/Prompt/AgentRun/Job 身份进入明确类型和列。
2. **Prompt Slot 与 ContextAssembler。** 收敛 Hook/角色/Memory/Narrative 注入，保留现有 Compaction 行为。
3. **统一 TurnRuntime/TurnLoop。** Chat/Work 共用主链，Narrative 变独立能力，旧 ConversationEngine 退役。
4. **Tool/Permission/Sandbox 主链复核。** Tool Manifest snapshot、Prepared Call hash、Session FIFO、跨平台 runner。
5. **AgentTask 语义拆分并完成 V1 Task。** 根投影删除，子执行迁 AgentRun；`src/tasks` 建立持久 Task、依赖、可选活动 Run 绑定、事件、Context 与 UI 全闭环，根 Turn 的 Task Tools 替换并删除 TodoWrite。
6. **事实与恢复收口。** Usage、Permission audit、AgentRun/Job recovery、单实例与 Desktop supervisor。
7. **前端投影切换。** Chat/Work、NarrativePolicy、Decision Card、AgentRun/Task 分面和多 Session 并行。
8. **逐模块迁根 `src`。** 每次先行为保持迁移、验证直接消费者，再做业务重构；不一次全仓搬目录。
9. **V1.5 才评估 Plan/Goal/Schedule/Workflow/Team/AutoReview。** 只有对应真实产品入口、恢复和安全语义齐备才注册 Tool。

### 全书一致性结论

- Claude 文档中的常量、阈值和文件布局是参考实现，不是 Ema 产品规范；Ema 的设置和硬上限由本地设备与业务场景决定。
- Prompt 约束、Hook、LLM 分类器都不能替代类型校验、事务、Permission 或 Sandbox。
- 所有模型 API 调用保持无 Session 状态；上层用 correlation context 记录身份，调用结束后投影 Usage/Event。
- 所有用户可恢复状态以 SQLite 事实为准；不再为模仿 Claude 额外维护平行 JSONL/Markdown 真相源。
- 开源与本地单人不代表可以忽略密钥、路径、跨渠道和 Prompt Injection；只是不需要复制 SaaS 多租户与云遥测架构。
- V1 的工业化重点是唯一主链、明确终态、可取消、可恢复、可审计和跨平台，不是把 V1.5 的所有高级入口提前做成空壳。

---

## 全局边界表（最终口径）

| 概念 | Ema 唯一含义 | 当前目标所有者 |
|---|---|---|
| Turn | 用户发起的一轮交互和唯一根终态 | `src/turn` + `src/agent/turnRuntime` |
| Task | 用户/根 Agent 可见、可持久化、可建立依赖并可选关联 AgentRun 的结构化工作项 | `src/tasks`（V1 必做） |
| Plan | 只读探索后供用户审批的实施方案 | V1.5 候选，暂不建包 |
| AgentRun | V1 中一次子 Agent 实际执行 | `src/agent/runs`（待从旧 agent-task 拆出） |
| BackgroundProcess | 一次可查询、可停止的后台 Shell 进程 | `src/tools/background`（V1 必做） |
| Job | KB、Vision、Embedding 等领域后台工作 | 各领域内部 |
| Schedule | Cron、唤醒与循环触发 | V1.5 候选，暂不建包 |
| Goal | 跨 Turn 的停止条件 | V1.5 候选，暂不建包 |
| Workflow | 确定性编排多个 AgentRun/领域步骤 | V1.5 候选，暂不建包 |
| Team | 多 Agent 成员、寻址与共享 Task | V1.5 候选，暂不建包 |
