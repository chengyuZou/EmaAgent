# EmaAgent 当前重构接力板

> 更新时间：2026-08-03
> 只记录当前阶段、工作区归属、最近验证和下一步。长期规则见 `CLAUDE.md`，目标结构见 `EmaRefactor.md`，Claude Code 对照与设计理由见 `EmaClaudeArchitectureReview.md`。

## 当前阶段

当前进入 **Tool 执行、结果与 UI 归属纠偏**。T1 的 Tool description 单一事实源和 T2 跨来源 ToolPool 所有权已经完成；复核 Claude 文档与真实源码后，确认现有 God `ToolExecutionRuntime`、独立 `ToolPresentation` 和前端工具名 switch 仍会继续制造职责与接口漂移。先完成这条 Tool 主链，再进入 Turn / Session / Transport 所有权；不重写已经成立的 AgentLoop，也不顺手实现 Plan。

最近完成的主线可视为既有地基：

- Chat/Work 已共用 `TurnExecutor + AgentLoop`，旧 `ConversationEngine`、`AgentEngine`、`agentContext` 与万能 HookBus 已删除；
- Prompt Slot、ContextAssembler、渐进 Compaction、Tool Manifest Snapshot、PreparedToolCall、Permission、Sandbox 与 ToolExecution 所有权已经进入唯一主链；现有执行文件内部仍需按单次调用和批次调度拆分；
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
AgentLoop → LLM → Tool Orchestration
                    ↓
               toolExecution
```

### 已冻结决定

1. **`tools.prompt` 旁路已经删除。** 每个 Tool 的详细用法只写在 `ToolDef.description`，经同一份 Manifest 进入 Provider `tools[].description`；Prompt Slot 不复制每个 Tool 的参数表、示例或错误语义。
2. **`ToolDef.prompt?` 已经删除。** Context Usage 的 `toolInstructions/toolSchemas` 仍分别展示，但都从同一 `ToolManifestSnapshot` 估算，不再读取 Prompt Slot 副本。具体内置 Tool 长说明由后续逐 Tool 对照 Claude 源码补写。
3. **Prompt 只拥有可信指令。** 产品规则、Character、Chat/Work Profile、NarrativePolicy 与通用工具选择原则进入显式 Slot；MCP、网页、附件、KB、Narrative、Memory 和 Skill 外部正文不能提升为产品 System 指令。
4. **Context 拥有最终模型窗口。** 每次 LLM Call 前重新组装模型可见消息、预算、缓存断点与压缩结果；TurnExecution 只冻结稳定输入和能力快照，不一次性永久拼好消息数组。
5. **Tool Manifest 是能力事实源。** 模型可见、PreparedToolCall、Permission 审批与实际执行必须共享同一 Tool 身份、Schema、版本和不可变输入。
6. **Builtin 全量注册不等于全量可见。** V1 支持的内置 Tool 默认注册且不提供用户启停 UI；实际可见集合仍由 ExecutionProfile、宿主能力、子 Agent 策略、Skill 收窄和冻结世代取交集。
7. **Builtin / MCP 分区稳定。** Builtin 是稳定前缀，MCP 是稳定后缀；活动 Turn 冻结后，MCP 异步连接或 `tools/list_changed` 不能在后续 Loop 中突然扩充 Manifest。
8. **Skill 只收窄 Tool 能力。** Skill Catalog/激活正文是 Context Contribution，不是新的 Tool 来源；脚本仍显式经过 Tool、Permission 与 Sandbox。
9. **Builtin 静态目录不等于每 Turn ToolPool。** `registerBuiltinTools()` 只对应 Claude `getAllBaseTools()`，注册进程可提供的实现；Profile、宿主能力、Subagent 和 Skill 的交集筛选归 `src/tools` 的 ToolPool，不能留在 Builtin 注册函数。
10. **单次 Tool 执行与批次调度分开。** `toolExecution` 是一个调用唯一的 Prepare/校验/Permission/Sandbox/Journal/Result 主链；静态 `toolOrchestration` 和 `StreamingToolExecutor` 只负责分组、硬并发上限、进度、命令兄弟取消和 FIFO 终态，必须复用单次入口。
11. **Tool Result 不再复制 Presentation。** 目标契约是类型化 `data + modelContent`：前者供持久化、审计和 UI，后者是模型有界投影。复杂 Builtin UI 与 Tool 同目录，通过前端专用子路径导出；Desktop 用稳定 `toolId` 的薄 renderer registry，简单/MCP/未知 Tool 使用通用回退。
12. **Tool 公共 execute 继续返回 Promise。** Bash 等长时工具可以在内部使用 AsyncGenerator 产生进度，再由 execute 消费并上报；不把所有 Tool 接口改成生成器。

## Tool、Permission 与 Sandbox

```text
模型 Tool 意图
  → ToolRegistry.prepare()       解析、规范化并冻结 PreparedToolCall
  → Tool 自身业务校验            路径、参数、前置读取、领域约束
  → Permission                   用户策略是否允许同一份 PreparedToolCall
  → Sandbox / Platform Runner    实际 OS 能力约束
  → Tool execute
  → ToolResult.data + modelContent
  → Result Budget / Journal / FIFO terminal
```

- Permission 不修改 Tool 输入、不决定 Tool 是否出现在 Manifest，也不替代 Tool 业务校验。
- Sandbox 不读取审批规则猜权限；批准不等于已隔离。目标、路径或身份变化后必须重新 prepare 和审批。
- Tool 的类型化 `data` 保存可信执行事实；模型给出的调用说明只用于调用前解释，不能参与安全决策。
- `src/tools` 拥有通用契约、Registry、Pool、Manifest、Prepared Call、单次执行、批次调度、结果预算、Journal 和后台进程。
- `src/builtinTools` 只拥有具体内置 Tool、静态 Builtin 目录和前端 UI 子路径，不拥有跨来源 ToolPool、Prompt、Permission、Sandbox 或调度。
- MCP 只提供外部 Tool 定义与执行适配；Server instructions、Resource 与 Prompt 是不可信贡献，不进入产品 System Slot。

## V1 多 Agent 边界

V1 只实现一种协作：**根 Agent → 隔离普通 Subagent**，可同步等待或在父 Turn 内后台运行。

- 不实现 Claude Coordinator、Team、Swarm、共享 Task owner 或 peer-to-peer Agent 权威模型；不为它们预建空包。
- 子 Agent 的 Tool 集合是父 Manifest、ExecutionProfile、SubagentPolicy、Skill 限制和宿主能力的交集，只能继续收窄。
- 普通子 Agent 不获得 Task Tools、AskUser、递归 Subagent 或独立 Permission 队列；需要用户输入时返回结构化需求给父 Agent。
- 父 Agent 验证子 Agent 结果后再更新 Task；AgentRun 成功不得隐式完成 Task。
- Character 是产品角色与 Prompt 身份，不是 Agent 成员身份；`characterId` 不能当作 `agentRunId`。

## 当前源码偏差

1. `src/tools/execution/toolExecutionRuntime.ts` 同时承担批次调度、单次调用、Permission、Journal、结果映射、取消和发射，已成为 God Runtime；目标不是换文件名，而是拆成单次主链与两种调度。
2. `src/tools/presentation` 和 `presentToolResult` WeakMap 复制了一份 Tool Result 事实；Desktop 的 `ToolCallBlock/tool-renderers` 又按工具名维护分支，三处容易漂移。
3. `src/builtinTools/builtinToolContext.ts` 仍是共享宿主能力袋；目标通用 `ToolUseContext` 和投影规则归 `src/tools/Tool`，具体 Tool 只接收窄 Context，业务 Port 继续由真实业务所有者定义。
4. `src/builtinTools/index.ts` 的静态注册仍按 `disableExecuteTools` 过滤 Bash，把进程目录和每 Turn 可见性混在一起；过滤应迁到 ToolPool。
5. `src/session/types.ts` 仍拥有 `Turn` 持久实体，而 `src/turn` 拥有 Turn 领域契约；所有权在 Tools 收口后单独处理。
6. `src/turn/turns.ts` 含本地 HTTP 请求/响应 DTO，最终应迁入 `apps/localHost` 的 Turns 协议层。
7. `src/tools/events.ts` 合并了 `TaskEvent`，Tool 事件不应反向拥有 Task 领域事件。

## 下一步批次

### T1：Tool description 单一事实源（已完成）

- 已删除 `ToolDef.prompt?`、`src/builtinTools/toolPrompt.ts`、`assembleToolPrompt()` 与 `tools.prompt` Slot；
- Context Usage 改为从 Manifest 同源拆算 description 与 Schema；
- 各 Tool 现有 description 未改，Claude 源码对照表已写入 `docs/toolPromptWorkspaceInstructionsAndContextUsage.md`；
- Tool Manifest、Builtin、Prompt、Context 与 TurnExecution 目标构建、类型检查和测试已通过。

### T2：Tool 装配所有权（已完成）

- 通用 `assembleToolPool()` 已迁入 `src/tools`，直接复用 `ToolRegistry`、`BuiltTool.requires` 与调用方现有宿主 Context；
- `src/builtinTools` 只保留具体 Tool、`BuiltinToolContext` 与 Builtin 静态注册，不再导出跨来源装配函数；
- 根 Turn、Subagent 与 Builtin 能力测试统一消费 `@ema-agent/tools` 的装配入口；Composition Root 仍把 Builtin 与 MCP 注册到同一个 Registry；
- ToolPool 通用测试覆盖 requires 能力过滤以及 Builtin/MCP 同 Registry、同规则；Manifest 既有测试继续锁定稳定来源分区、revision 与 MCP 重连失效。

### T3：Tool 单次执行与批次调度

- 从现有 `ToolExecutionRuntime` 提取单次 `toolExecution`，静态批次和流式执行器都复用同一入口；
- 把共享 `BuiltinToolContext` 收回为 Tools 的通用 `ToolUseContext` 与窄投影规则，不复制业务 Port，不再给所有 Tool 暴露同一个能力袋；
- 静态批次固定并发安全分组、危险屏障和硬并发上限；流式执行器固定进度、Bash 兄弟取消和模型顺序 FIFO 终态；
- 保留 PreparedToolCall、Permission、Sandbox、Journal、结果预算的既有安全语义，不另建 Agent Scheduler，也不引入含糊 Runner。

### T4：Tool Result 与 Builtin UI

- 把具体 Tool 输出收口为类型化 `data + modelContent`，删除 Presentation WeakMap 和重复联合；
- 复杂 Builtin Tool 的 `UI.tsx` 经 frontend-only 子路径导出，后端入口不加载 React；
- Desktop 用稳定 `toolId` renderer registry 替代工具名 switch，公共状态/权限/错误外壳与 Tool 自有结果 UI 分层。

### T5：Turn / Session / Transport 所有权

- Turn 领域实体和终态回到 `src/turn`；Session 只保存会话与消息；
- HTTP DTO 回到 `apps/localHost/src/routes/turns`；
- 保持现有 SQL Schema、URL 和 SSE 协议，单独迁移，不与 T1/T2 混批。

### T6：事件聚合边界复核

- 拆除 `ToolExecutionEvent | TaskEvent` 的反向组合；
- 只在真正聚合层组合跨域事件；
- Tool 事件只携带类型化结果封套或稳定引用，不在事件层再次定义展示事实。

## 当前工作区归属

本轮只修改 Tool 架构权威文档。源码工作区已有 Tools、BuiltinTools、Agent 与 TurnExecution 的在途改动，属于此前批次或用户/其他 Agent；后续实现前必须重新查看 Diff，禁止覆盖或回退。当前已知工作区包括：

```text
M  src/agent/spawner.ts
D  src/builtinTools/assembleToolPool.ts
M  src/builtinTools/index.ts、测试
M  src/tools/background/*、build-tool.ts、execution/*、journal/*、registry.ts、results/*、测试
?? src/tools/assembleToolPool.ts、errors.ts、tests/assembleToolPool.test.ts
M  src/turnExecution/turnTools.ts
```

## 本轮验证

- T2 的 `@ema-agent/tools`、`tool-builtin`、`agent`、`turn-execution` typecheck 全通过；
- T2 测试：Tools 35/35、Builtin 106 通过 + 1 跳过、Agent 19/19、TurnExecution 20 通过 + 4 个 integration 跳过；
- T2 四个相关模块 build 全通过；BuiltinTools 已清理旧 dist 后重建，旧 `assembleToolPool` 生成物不存在；
- T1 的 Prompts 9/9、Context 34/34 与相关构建仍保持上一轮通过；
- 已阅读 Claude Plan Mode 文档并复核 `EnterPlanModeTool`、`ExitPlanModeV2Tool`、`query()` 与 Tool 注册链：Plan 复用同一 Engine，Ema 实现时必须在根 Turn 边界重建冻结 Manifest。
- 本轮只修改文档，没有重新运行源码测试或构建；上述通过记录属于 T1/T2 最近一次验证。

## 接力提示

下一次从 T3 开始。先完整核对 `src/tools/execution/toolExecutionRuntime.ts`、AgentLoop 的静态/流式消费方、Permission、Sandbox、Journal、Result Store 和相关事件，再冻结单次调用输入输出后拆批次调度；不要同时迁 Turn DTO、实现 Plan 或修改 SQL Schema。T3 完成后再进入 T4 类型化 Result 与 Builtin UI，最后才回到 Turn / Session / Transport。
