# EmaAgent 当前重构接力板

> 更新时间：2026-08-02
> 只记录当前阶段、工作区归属、最近验证和下一步。长期规则见 `CLAUDE.md`，目标结构见 `EmaRefactor.md`，Claude Code 对照与设计理由见 `EmaClaudeArchitectureReview.md`。

## 当前阶段

当前进入 **Tool / Prompt / Context / Agent 边界复核与纠偏**。本阶段不重写已经成立的 Agent 主链，也不补写各个内置 Tool 的 Claude 风格长说明；只消除重复事实源、把通用装配放回正确所有者，并冻结后续不得偏移的规则。

最近完成的主线可视为既有地基：

- Chat/Work 已共用 `TurnExecutor + AgentLoop`，旧 `ConversationEngine`、`AgentEngine`、`agentContext` 与万能 HookBus 已删除；
- Prompt Slot、ContextAssembler、渐进 Compaction、Tool Manifest Snapshot、PreparedToolCall、Permission、Sandbox 与 ToolExecutionRuntime 已形成唯一主链；
- `apps/localHost` 已退回本机进程宿主、HTTP/SSE、认证和 Composition Root；Route 不再承载业务编排；
- Task、AgentRun、后台 Shell、Memory 闲置维护、Narrative Bridge、Character 资源、Session Backup、Settings 与主要前后端投影均已落地；
- 已完成部分不再在接力板逐批复述，具体设计与历史依据保留在两份架构文档和 Git 历史中。

## 本轮冻结的领域语言

```text
Session
└─ Turn                         一次有触发原因和唯一根终态的交互
   └─ Root AgentLoop            本 Turn 内 LLM → Tool → Result 的迭代
      ├─ LlmCall / ToolCall
      └─ Subagent AgentRun      可选；一次子 Agent 执行记录
         └─ isolated AgentLoop
```

- `Session`：持久会话、历史消息、会话偏好与工作区绑定，不执行 Agent 循环。
- `Turn`：低依赖领域身份、触发、状态、事件与唯一终态，不持有 LLM、Tool、Repo 或 HTTP DTO。
- `turnExecution`：执行一个根 Turn 的应用用例；冻结输入，协调 Context、根 Agent、持久化、取消和终态。
- `agent`：只负责一个 Agent 的 LLM → Tool → Result 循环、预算、取消、子 Agent 与 AgentRun；不创建根 Turn，不拥有 Session 持久化。
- `Task`：跨 Turn 的持久工作项；不是 AgentRun、后台进程或领域 Job。
- `AgentRun`：一次子 Agent 执行记录；根 Agent 不再复制一份 AgentRun。
- `BackgroundProcess`：后台 Shell 进程，归 Tool 执行业务；不是 Task 或 AgentRun。

## Prompt、Context 与 Tool 的唯一数据流

```text
PromptAssembler
  └─ PromptSnapshot             可信产品规则、角色、Profile 与通用工具选用原则

ToolRegistry / ToolPool
  └─ ToolManifestSnapshot       每个可见 Tool 的完整 description、schema、origin、version

ContextAssembler
  ├─ PromptSnapshot
  ├─ ToolManifestSnapshot
  ├─ history / current input
  └─ Memory / Narrative / KB / Skill contributions
      ↓
ModelContextSnapshot
      ↓
AgentLoop → LLM → ToolExecutionRuntime
```

### 已冻结决定

1. **删除 `tools.prompt` 旁路。** 每个 Tool 的详细用法只写在 `ToolDef.description`，经同一份 Manifest 进入 Provider `tools[].description`；Prompt Slot 不复制每个 Tool 的参数表、示例或错误语义。
2. **`ToolDef.prompt?` 不再保留。** `src/builtinTools/toolPrompt.ts`、`tools.prompt` Slot、重复 Context Usage 统计和对应测试属于下一批删除对象。具体内置 Tool 长说明由后续逐 Tool 对照 Claude 源码补写，本轮不代写。
3. **Prompt 只拥有可信指令。** 产品规则、Character、Chat/Work Profile、NarrativePolicy 与通用工具选择原则进入显式 Slot；MCP、网页、附件、KB、Narrative、Memory 和 Skill 外部正文不能提升为产品 System 指令。
4. **Context 拥有最终模型窗口。** 每次 LLM Call 前重新组装模型可见消息、预算、缓存断点与压缩结果；TurnExecution 只冻结稳定输入和能力快照，不一次性永久拼好消息数组。
5. **Tool Manifest 是能力事实源。** 模型可见、PreparedToolCall、Permission 审批与实际执行必须共享同一 Tool 身份、Schema、版本和不可变输入。
6. **Builtin 全量注册不等于全量可见。** V1 支持的内置 Tool 默认注册且不提供用户启停 UI；实际可见集合仍由 ExecutionProfile、宿主能力、子 Agent 策略、Skill 收窄和冻结世代取交集。
7. **Builtin / MCP 分区稳定。** Builtin 是稳定前缀，MCP 是稳定后缀；活动 Turn 冻结后，MCP 异步连接或 `tools/list_changed` 不能在后续 Loop 中突然扩充 Manifest。
8. **Skill 只收窄 Tool 能力。** Skill Catalog/激活正文是 Context Contribution，不是新的 Tool 来源；脚本仍显式经过 Tool、Permission 与 Sandbox。

## Tool、Permission 与 Sandbox

```text
模型 Tool 意图
  → ToolRegistry.prepare()       解析、规范化并冻结 PreparedToolCall
  → Tool 自身业务校验            路径、参数、前置读取、领域约束
  → Permission                   用户策略是否允许同一份 PreparedToolCall
  → Sandbox / Platform Runner    实际 OS 能力约束
  → Tool execute
  → Result / Presentation / Journal
```

- Permission 不修改 Tool 输入、不决定 Tool 是否出现在 Manifest，也不替代 Tool 业务校验。
- Sandbox 不读取审批规则猜权限；批准不等于已隔离。目标、路径或身份变化后必须重新 prepare 和审批。
- Tool Presentation 展示可信执行事实；模型给出的调用说明只用于调用前解释，不能参与安全决策。
- `src/tools` 拥有通用契约、Registry、Pool、Manifest、Prepared Call、执行、结果预算，以及跨端 Presentation 协议和可信事实构造器。
- `src/builtinTools` 只拥有具体内置 Tool、Builtin 目录与它们的静态注册，不拥有跨来源 Tool Pool 或 Prompt 装配。
- MCP 只提供外部 Tool 定义与执行适配；Server instructions、Resource 与 Prompt 是不可信贡献，不进入产品 System Slot。

## V1 多 Agent 边界

V1 只实现一种协作：**根 Agent → 隔离普通 Subagent**，可同步等待或在父 Turn 内后台运行。

- 不实现 Claude Coordinator、Team、Swarm、共享 Task owner 或 peer-to-peer Agent 权威模型；不为它们预建空包。
- 子 Agent 的 Tool 集合是父 Manifest、ExecutionProfile、SubagentPolicy、Skill 限制和宿主能力的交集，只能继续收窄。
- 普通子 Agent 不获得 Task Tools、AskUser、递归 Subagent 或独立 Permission 队列；需要用户输入时返回结构化需求给父 Agent。
- 父 Agent 验证子 Agent 结果后再更新 Task；AgentRun 成功不得隐式完成 Task。
- Character 是产品角色与 Prompt 身份，不是 Agent 成员身份；`characterId` 不能当作 `agentRunId`。

## 当前源码偏差

1. `src/builtinTools/toolPrompt.ts` 与 `ToolDef.prompt?` 会把 Tool 用法复制成 `tools.prompt` System Slot，和 Provider Tool description 形成双事实源。
2. `assembleToolPool()` 位于 `src/builtinTools`，但它负责通用可见性筛选和跨来源装配，应迁回 `src/tools`。
3. `src/session/types.ts` 仍拥有 `Turn` 持久实体，而 `src/turn` 拥有 Turn 领域契约；所有权仍需单独收口。
4. `src/turn/turns.ts` 含本地 HTTP 请求/响应 DTO，最终应迁入 `apps/localHost` 的 Turns 协议层。
5. `src/tools/events.ts` 合并了 `TaskEvent`，Tool 事件不应反向拥有 Task 领域事件。

## 下一步批次

### T1：Tool description 单一事实源

- 删除 `ToolDef.prompt?`、`src/builtinTools/toolPrompt.ts` 与 `assembleToolPrompt()`；
- 删除 `tools.prompt` Slot、重复 Context Usage 分类与失去意义的测试；
- 保持各 Tool 现有 description 不变，后续由用户/其他 Agent 逐个对照 Claude 补全；
- 验证模型看到的 description、Schema 和运行时可执行 Manifest 来自同一 Snapshot。

### T2：Tool 装配所有权

- 将通用 `assembleToolPool()` 迁入 `src/tools`，按 Builtin 稳定前缀、MCP 稳定后缀冻结顺序和 revision；
- `src/builtinTools` 只保留具体 Tool 与 Builtin 注册目录；
- Composition Root 注册 Builtin 与 MCP，Profile/Skill/Subagent 只对冻结集合做交集收窄。

### T3：Turn / Session / Transport 所有权

- Turn 领域实体和终态回到 `src/turn`；Session 只保存会话与消息；
- HTTP DTO 回到 `apps/localHost/src/routes/turns`；
- 保持现有 SQL Schema、URL 和 SSE 协议，单独迁移，不与 T1/T2 混批。

### T4：事件聚合边界复核

- 拆除 `ToolExecutionEvent | TaskEvent` 的反向组合；
- 只在真正聚合层组合跨域事件；
- 保留已经成立的跨端 Tool Presentation 协议，不在事件批中重搬展示事实。

## 当前工作区归属

本轮只修改 `CLAUDE.md`、三份架构/接力文档和既有 Tool 说明设计稿，不修改运行代码。下列工作区内容属于用户或其他 Agent，禁止覆盖或回退：

```text
M  .gitignore
M  apps/localHost/src/bootstrap/startLocalHost.ts
D  src/builtinTools/tools/PlanModeTool/PlanModeTools.ts
M  src/rerank/runtime.ts
M  src/storage/repos/data/usage-records.ts
M  src/tts/coordinator.ts
M  src/usage/index.ts
?? src/usage/record.ts
```

## 本轮验证

- 文档依据：已重新阅读 Claude Code 的 System Prompt、Permission Security、Multi-Agent 章节，并复核 Ema 对应源码与两份架构文档。
- 本轮为文档批，不运行 typecheck 或测试。
- 完成后只执行 `git diff --check` 与文档 Diff 复核。

## 接力提示

下一次从 T1 开始。先重新阅读本文件和 `CLAUDE.md`，再确认其他 Agent 是否正在修改 `src/tools`、`src/builtinTools`、`src/prompts`、`src/context` 或 `src/turnExecution/turnTools.ts`。不要在 T1 同时迁 Tool Pool、Turn DTO 或事件体系。
