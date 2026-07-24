# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-07-24
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。现在不再继续机械搬包，也不建立第三套 Engine；长期主线仍是把现有 `AgentEngine + Core Orchestrator` 收敛为唯一的 `TurnRuntime + AgentLoop`。内层 `AgentLoop`、Tools 主执行链和 Tool 调用边界都已完成收口；当前先完成 Tool Manifest 缓存稳定性（2C）与 Builtin Tool 审查（2D），随后直接把现有 `AgentEngine` 迁成 `TurnRuntime`，不在其上新增包装层。

事件所有权第一批已经落到源码：Agent、Artifact、Characters、Context、Hooks、Knowledge、Memory、Narrative、System、Tasks、Tools 与 TTS 各自拥有 `events.ts`；Turn 只保留根生命周期、输出、Usage 与请求降级事件。`src/events` 像 `src/ids` 一样执行严格准入，但只负责组合 `TurnStreamEvent/SessionEvent/AppEvent`，禁止定义业务字段。`EmaStreamEvent` 已标记为迁移期兼容名，新生产者必须使用领域事件或窄通道事件。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

Prompt 装配边界已经完成新语义收口：公共入口只接受全局 Active Character、`ExecutionProfile`、`NarrativePolicy` 与显式扩展贡献；旧 `buildSystemPrompt`、`buildModeBlock`、`legacyExecutionProfile` 和工作区路径注入已删除。Prompt 源码不再依赖 `contracts`，Skill Catalog 只在 Work Profile 作为扩展 Context 提供。运行时历史、召回、附件和工作区事实继续由 Context 所有。

Prompt 缓存边界已进一步落到真实模型请求：稳定范围改为 `product / activeCharacter / turn`，全局激活角色不是 Session 绑定；产品规则与全局角色各自形成 System Block 和缓存断点，Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部。Skill Catalog 作为普通 Context Message 投递并限制为 8000 字符总预算、250 字符单项描述，不能取得 System 权限。Context 会冻结日期、平台、工作区和模型身份，并输出分层 Prompt Revision、Tool Manifest Revision 与 Prefix Hash。Anthropic Adapter 已支持保留多层 System Block，不再由后一条覆盖前一条。

Context 的缓存链已经补齐请求尾部断点：最终模型请求的最后一条非空消息会获得仅存在于只读投影中的动态 `cacheBreakpoint`，历史和已完成 Tool Round 因此能够进入下一次调用的缓存前缀；该标记不写回 Session、Turn 工作消息或压缩历史。

Compaction 已迁出旧三 Mode：摘要结构只由 `ExecutionProfile = chat | work` 决定，`NarrativePolicy` 随事件保留但不选择第三套模板。Macro 使用可丢弃的 `<analysis>` 草稿提升摘要质量，只把 `<summary>` 写入上下文；Safe Cut 已合并为按 `toolUseId` 检查整段 tail 的单一算法，支持工具消息之间插入附件，同时阻止孤立 `tool_result`。

Prompt/Context 的 V1 目录边界已经规范化：`contextSnapshot.ts` 独立拥有单次模型调用的不可变输入、输出与缓存诊断，`types.ts` 只保留 Contribution 和压缩协作契约；`slots.ts` 独立拥有 Slot 身份、顺序、稳定范围、投递方式与信任级别。Context Contribution 公共请求已移除 `TurnMode`，直接使用 `ExecutionProfile + NarrativePolicy`；Memory 公开召回入口接收新契约，旧检索分区的临时映射收回 Memory 内部。

统一 Turn 主线的内层循环已经完成：公网请求使用 `trigger + executionProfile + narrativePolicy`；`runAgentLoop()` 同时服务根 Agent 与 Subagent，只管理 LLM、Tool、Result 迭代。循环不再依赖 `EmaStreamEvent`，执行器事件通过泛型交给外层翻译；完成结果通过唯一 `AgentLoopOutcome` 返回，不再伪装成 `loop_done` 流事件。Session/Turn SQL 显式保存触发来源、执行 Profile 与 Narrative 策略；Desktop 顶层选择器只显示 Chat/Work，Narrative 使用 `auto/always/off` 二级策略。

Provider 配置也已完成旧列清理：顶层 `base_url`、`config_json`、`capabilities_json` 被物理删除，地址、协议和能力开关只保存在 `provider_capability_configs`。Session/Turn 无业务读取的 `meta_json` 同步删除；Message、MCP、Artifact 等仍有明确用途的 JSON 未动。

Contracts 第一批所有权回流已经完成：`agents.ts`、`sessionOwnership.ts`、`kb.ts`、`capabilities.ts`、`wire.ts` 已删除。Agent 初始化种类归 Turn 事件边界，工具执行审计归 Tools/Storage，知识检索结构归 Knowledge，Session 归属校验与 REST DTO 归 Session，发布能力、沙箱状态和备份警告分别归 System、Sandbox、Backup。数据形状和运行语义未改变。

Contracts 消息契约也已收口：`contracts/messages.ts` 和 `ids.ts` 中的 `MessageRole` 已删除。LLM 继续独立拥有纯模型消息；Turn 拥有请求媒体、附件输入与 Tool 展示协议；Session 拥有持久化 MessageBlocks、Narrative Block 及 UI/审计扩展字段；Storage 拥有数据库 `MessageRole/MessageKind` 枚举。Session 读取 `blocks_json` 时现会按 role/kind 校验，损坏内容不再原样暴露。

消息待修项已经收口：本轮模型调用仍可临时使用 Base64，但写入 `messages.blocks_json` 前会删除图片、音频和文件正文，磁盘附件改为 `attachment_ref` 稳定引用；历史模型窗口只得到明确占位，不会静默重读旧文件。Data v16 已物理删除从未被业务读取的 `messages.meta_json`，Fork 与备份恢复 SQL 同步移除该列。

Artifact 类型所有权已回到 `src/artifact`：Artifact 数据结构、`ArtifactId/asArtifactId`、存储端口、工具注入接口和归属错误都由 Artifact 模块导出；Storage 只实现持久化端口，Tools/Turn/Core/Desktop 只依赖 Artifact 公共入口。`contracts/artifact.ts` 及中央 Artifact ID 已删除，V1 Feature Gate 继续保持禁用。

Contracts 错误所有权已经收口：中央 `ErrorCode` 改为 Turn 拥有的 `TurnFailureCode`，只描述当前确实可能通过 `turn_failed` 暴露的 11 个终态码；LLM、Vision、STT、Narrative、Knowledge 等继续保留各自领域错误。无生产者的旧 Auth、Tool、Memory、Narrative、Storage、TTS/STT 与 System 占位码已删除，`contracts/errors.ts` 不再存在。

Contracts 外壳已经删除：跨业务边界共享的 branded ID 收口为零业务依赖的 `src/ids` 叶子模块，并通过准入规则禁止业务对象、状态、事件、错误和 DTO 进入。`TurnStatus` 已回到 Turn；旧 `TurnMode` 及 Session/Conversation/Hook/Core 的兼容投影已经删除，运行链直接使用 `ExecutionProfile + NarrativePolicy`。

Memory 与 Narrative 的旧分区也已经拆开：Memory 只按 `chat/work` 记录提取与召回范围，旧 `agent` 标签迁为 `work`、旧 `narrative` 标签迁为 `chat`；Narrative 继续作为独立 LightRAG Contribution，不再进入 Memory 类型和任务载荷。Profile v11 将 `memory_items.modes_json` 迁为 `profiles_json`。

Agent 执行体系第一批已经完成：Tool Result 外置与 Cleaner 从 `agentContext` 迁入 `tools/results`；`maxResultBytes` 和 200KB 聚合预算取代工具名白名单；MCP 动态工具通过统一 `buildTool()` 保留 Server JSON Schema 并继承 50KB 默认预算；`validateInput` 与 `requiresUserInteraction` 已进入真实执行链。`requiresUserInteraction` 只表达工具是否主动暂停 Turn 等待用户，不能被 Claude 的 `interruptBehavior = cancel | block` 替代；后者描述工具运行时收到新用户消息后的中断策略，等 TurnRuntime 统一插话和排队语义后再接。`ToolOrigin` 进一步把 Builtin/MCP 来源及原始 MCP 身份带入 Manifest 和 Prepared 快照，Registry 会拒绝来源声明与注册所有者不一致的工具。

Agent 执行体系第二批已经完成：ToolExecution Journal 从 Tasks 收回 `src/tools/journal`，Tools 现在拥有状态、领域记录、Store 端口、CAS 状态机与崩溃恢复语义；Storage 只实现原子 SQL 操作并把数据库行投影为领域形状；Core 从 Tools 装配 Journal，Agent 只依赖 `ToolExecutionJournalPort`。原 `IToolExecutionJournal` 已删除，Tasks 不再依赖 Tools/IDs 或导出工具执行生命周期。

Sandbox 依赖反转已经完成：进程启动、超时、取消和有界输出收回 `src/sandbox/processRunner.ts`，`CommandRunnerPort/CommandRunOptions/CommandRunResult` 只由 Sandbox 定义。Sandbox 不再依赖 Tools 或 Permission，也不从审批规则猜 OS 文件能力；Core 直接注入工作区、可写路径、私有路径和网络能力快照。Bash 删除裸 `spawn` 回退与假后台参数，无 Runner 时明确拒绝；无法进入现有 OS Sandbox 的 PowerShell Tool 已移除。无工作区不再回退 Sidecar 的 `process.cwd()`，子 Agent 当前本就不获得 Bash 能力。

Tools 主执行链归位已经完成：`ToolRegistry.dispatch()` 组合捷径已删除，可信测试调用同样显式使用 `prepare()` 与 `execute()`；原 Agent 内执行器迁为 `src/tools/execution/toolExecutionRuntime.ts`，统一承担并发栅栏、PreparedToolCall 校验、Permission、Journal、取消、结果预算和执行事件。Tools 通过窄 `ToolLifecycleObserver` 接受观察能力，不反向依赖 Agent、Session 或 Hooks；Agent 只负责把现有 HookBus 适配进来，并消费 `ToolExecutionResult` 决定下一轮。`ToolFailurePhase` 同步回到 Tools，Session 只扩展持久消息允许的媒体结果结构。

Tool 调用边界已经收窄：旧万能 `ToolExecutionContext/ToolExecutionScope/ToolInvocationContext` 已删除。Ema 内置工具只在集成层共享一次执行的 `BuiltinToolContext`；每个 Tool 必须先用 `validateContext()` 校验并投影自己的窄 Context，`execute()` 看不到其他业务能力。ToolExecutionRuntime 只按调用覆盖 `toolCallId/signal/emit`，MCP 动态工具也使用同一四泛型契约。根 Agent 与子 Agent 先按实际 Context 装配 Manifest，再从同一 Manifest 建立 Policy；旧 Bridge 注册标志和子 Agent 手写白名单已删除。

旧 `src/agentContext` 已完整删除：Tool Result 生命周期此前已归 `src/tools/results`；本轮把按 Session 的文件读取状态迁为 `src/tools/sessionFileStateStore.ts`，同步删除无人消费的 `AgentContextSnapshot`。`IFileStateStoreEntry/IFileStateStore` 已按所有权改为 `FileStateStoreEntry/FileStateStore`，Core 与 Agent 不再依赖 `@ema-agent/agent-context`。

V1 Task 主链已经完成：`src/tasks` 只保存跨 Turn 的用户/模型可见工作项，Data v18 使用显式 Task 列、Session 内短序号、依赖关系和 CAS；根 Work Turn 注册 TaskCreate/Get/List/Update，旧内存 TodoWrite 已删除。Task 事件、低频动态 Context 提醒、`/api/tasks` 重启快照、Session ZIP 备份恢复与独立前端 TaskList 已接线。

Task 与子 Agent 的 V1 边界已经进一步冻结：四个 Task Tools 只向根 Turn 注册；普通 Subagent 不读取或修改共享 Task List。根 Agent 可用可选 `taskId` 启动一次 AgentRun，绑定前必须验证同 Session、未终态、无未完成依赖且没有其他活动 Run；不带 `taskId` 的临时调查合法。AgentRun 成功、失败或取消只结束执行并释放活动绑定，不自动完成、取消或删除 Task；父 Turn 验证结果后再显式 `TaskUpdate`。Claude 的 Task `owner` 属于 Team Member 语义，Ema V1 不用临时 `AgentRunId` 冒充长期 owner。

AgentRun 语义收口已经完成：旧 `src/tasks` 运行记录、根 Turn 的 AgentTask 投影及 `AgentTurnLifecycleFacade` 已删除；Data v17 只把真实子执行迁入 `agent_runs/agent_run_messages`。Subagent 内部、模型工具、Core HTTP 与 Desktop Store/Panel 统一使用 `agentRunId` 和 `/api/agent-runs`，Tool Journal 同时保存父 `turnId` 与可选 `agentRunId`，不再互相冒充；旧 `/api/agent-tasks`、`TaskPanel` 与 `agent-task-store` 已删除。客户端 SSE 暂时只在跨端事件字段保留 `subagentId`，值仍是 AgentRunId。

Session 历史语义已经收口：Data v19 删除 `branches`、`sessions.active_branch_id`、`turns.branch_id` 与对应 Repo/协议/UI。侧栏 Fork 完整复制 Session；已完成回复下的 Fork 按 `untilTurnId` 复制到该轮（含）为止并切换到独立 Session。用户气泡只允许回滚最后一个非运行 Turn 后重发；任意 Turn 删除、BranchPanel、`<N/M>` 导航和延迟分叉状态机均已删除。旧 Binary Lifting、Euler Tour + RMQ、恢复算法与前端布局已原样保存在 `D:\Github\EmaAgentBranchArchive`，36 个源码文件的 SHA-256 已与删除前版本逐一校验。

Chat 长历史读取契约已经完成：`GET /api/sessions/:id/turn-index` 使用不透明复合游标返回不含消息正文的轻量 Turn 索引；`GET /api/sessions/:id/messages/window` 按锚点 Turn 读取有界前后窗口，并返回旧到新的 Turn 与消息。查询复用现有 `idx_turns_session_latest`，无需新增迁移；最近热区仍沿用现有消息入口，前端可以只常驻近期正文与远期索引。

Chat 长历史前端主链已经完成：每个 Session 独立维护热尾/归档模式、轻量 Turn 索引和最多三个历史窗口；TurnRail 只渲染当前可视索引窗口，滚轮按需读取更早索引，点击冷 Turn 才加载有界消息正文。轨道容器保持透明，刻度按悬停距离形成双向声波式过渡并复用 UI Tooltip；查看旧窗口期间 SSE 热尾继续运行，以“新回复 · 回到最新”显式返回。

Task 与 AgentRun 前端已经分面：Desktop 使用正式 `/api/tasks` 快照维护跨 Turn 工作项，使用 `/api/agent-runs` 快照与 `AgentRunPanel` 展示子智能体执行和 transcript。两类 Store 在 HTTP 加载期间收到实时事件都会丢弃旧响应并重读，避免版本或运行态回退。输入框上方 Task/Diff 使用不可见中心轴；Task 原位展开 TaskList，Diff 使用真实 ToolPresentation 打开右侧 `review` 槽。

## 迁移完成事实

- 所有 Ema 产品模块均位于根 `src`；旧产品目录不再留在 `packages`。
- `packages` 目前只保留 `credential` 与 `public-http` 两个可复用技术底座。
- `conversation`、`agent`、`tools`、`builtinTools`、`tasks`、`storage`、`sandbox`、`system`、`ui`、`live2d-react` 等产品模块均位于 `src`；旧 `agentContext` 与 `contracts` 已收口删除，旧 `tasks` 运行记录语义已由真正的持久工作项替代。
- 模块内部仍可保留 `@ema-agent/*` Workspace 包名；它们是编译边界，不表示公共 npm 包。
- 旧产品 `packages/...` 源码路径审计为零。测试中最后两处硬编码迁移路径已改为 `src/agent`。

## 当前工作区

开始任何新批次前必须重新运行 `git status --short` 与 `git diff`，保留用户和其他 Agent 的修改。

当前工作区只包含本批 Tool Context 收口修改：MCP 契约、Builtin ToolPool、Agent 根/子执行接线、Sandbox 命令后清理、对应测试和文档。开始本批时工作区干净，没有覆盖用户或其他 Agent 的未提交修改。

当前基线最近提交：`f8035470 Refactor tool context handling and validation across Task and Web tools`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是一次有明确触发原因与唯一终态的有界 Agent 执行；V1 只接用户消息触发。TurnRuntime 管根生命周期、身份、持久化、取消与唯一终态，AgentLoop 管一个 Turn 内重复的 LLM/Tool/Result 迭代。
- 未来 Realtime/读屏/主动说话/直播属于长生命周期媒体或唤醒能力，不是新 Mode，也不能成为一个永不结束的 Turn；V1 暂不实现。
- Narrative 是保留多周目 Query Route 和专用前端 Block 的独立 RAG 能力，不是第三个 Engine。
- ContextAssembler 是模型窗口唯一组装入口；PromptAssembler 只产出显式、有序、可版本化的 PromptSlot。
- Provider 是控制面；LLM、Embed、Rerank、Vision、STT、TTS 是无 Session 状态的执行面。
- Tool 使用同一份不可变 PreparedToolCall 完成准备、审批和执行；Permission 与 Sandbox 物理分层。
- V1 完整实现持久 Task：TaskCreate/Get/List/Update、依赖、AgentRun 可选绑定、事务/CAS、事件、Context 提醒、恢复快照与独立前端 TaskList；Task Tools 只属于根 Turn，TodoWrite 完成迁移后删除。
- 后台 Shell 是 BackgroundProcess，使用 ProcessOutput/ProcessStop；不复用 TaskId、AgentRunId 或领域 Job 生命周期。
- Memory 只管理长期记忆；Compaction 属于 Context；Narrative、Knowledge Base、Memory 保持隔离。
- branded ID 只允许进入零业务依赖的 `src/ids`；业务类型、状态、事件与错误仍归各自所有者。事件按范围组合为 `AgentLoopEvent`、`TurnEvent`、`AgentRunEvent`、`SessionEvent` 与 `AppEvent`，不再让 Turn 组合整个应用的万能事件联合。
- 已知字段使用明确 type/interface/SQL column，不用 `meta`、`metaJson` 或万能 JSON 让调用方猜。
- Artifact 保留源码但由 V1 Feature Gate 禁用。

## 概念边界

```text
Turn       一次由明确来源触发、具有唯一终态的有界 Agent 执行
Task       跨 Turn 持久、用户/根 Agent 可见并支持依赖与可选 AgentRun 绑定的结构化工作项
AgentRun   V1 中一次子 Agent 实际执行
Process    一次可查询、可停止的后台 Shell 进程
Job        KB、Vision、Embedding、Memory 等领域后台工作
Plan       只读探索后供用户批准的方案
Goal       跨 Turn 的完成条件
Schedule   Cron、事件或时间唤醒
Workflow   确定性编排多个 AgentRun 或领域步骤
Team       多 Agent 成员、寻址与共享 Task
```

Plan、Goal、Schedule、Workflow、Team 与 LLM 自动审批暂列 V1.5，不创建空包、空表或半成品 UI。

## 下一批建议顺序

Chat 工作区、Turn 导航轨、Task/AgentRun 分面、双 Dock、置顶摘要和桌面打开方式的完整实施草案已写入 `EmaChatWorkspacePlan.md`。该文档只冻结交互、数据契约、文件边界和分批方式，尚未创建空 Terminal/Browser/Review UI。

1. TurnIndex/MessageWindow 与前端历史 Store/TurnRail 已完成，不创建 Dock 半成品；
2. TaskList、AgentRunPanel、原生 AgentRun API 与真实 Review 入口已经完成，旧 `/api/agent-tasks` 兼容已删除；
3. Sandbox 依赖反转、Tools 主执行链归位、单一 `BuiltinToolContext + validateContext` 窄投影与真实 ToolPool 接线均已完成；
4. 下一批完成 Tool Manifest 的 Builtin/MCP 稳定分区、Prefix Revision 与缓存稳定测试（2C）；
5. 随后逐组审查 Builtin Tool 的环境净化、工作目录、输入输出上限与结构化 Presentation（2D）；
6. Tool 批次完成后建立 TurnRuntime，再清理 Agent 并让 Core Route 退回协议层；
7. 后台进程按 `BackgroundProcess + ProcessOutput/ProcessStop` 单独实现 C 档，不修改 AgentLoop，也不恢复假 `run_in_background`。

命名随业务批次清理：`IFileStateStoreEntry/IFileStateStore/IToolExecutionJournal` 已在所有权迁移时改为职责名；其余迁移期 `I*` 类型继续随业务边界处理，不单独进行全仓机械重命名。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

- Tool Context 与真实 ToolPool 收口：Tools、BuiltinTools、MCP、Agent、Core 定向 typecheck 43/43 通过；Tools 26/26、MCP 25/25、Sandbox 19/19、Agent 29/29 通过，4 个 Agent Live Integration 按规则跳过；BuiltinTools 48/49，唯一失败仍是既存 WebFetchPolicy 对 `example.com -> www.example.com` 重定向口径，与本批无关。旧 `ToolExecutionContext/ToolExecutionScope/ToolInvocationContext`、Bridge 注册标志和子 Agent 手写工具白名单的源码引用归零；`git diff --check` 通过，仅有既有 CRLF 提示。
- Tools 主执行链归位：全仓 typecheck 84/84 通过；Tools 26/26、Hooks 27/27、Agent 31/31 通过，4 个 Agent Live Integration 按规则跳过；BuiltinTools 本批相关测试与修改后的 Tool Call Integration 通过，全量仍只有既存 WebFetchPolicy 对 `example.com -> www.example.com` 重定向口径的 1 项失败。Tools 对 Agent/Session/Hooks、旧 `TurnToolExecutor/tool-executor` 与代码侧 `dispatch()` 引用扫描归零。
- Sandbox 依赖反转：全仓 typecheck 84/84 通过；Sandbox 5 个测试文件 19/19 通过；Bash 边界与注册测试 8/8 通过。BuiltinTools 全量测试中本批相关测试均通过，唯一失败仍是既存 `WebFetchPolicy` 对 `example.com -> www.example.com` 重定向口径不一致，与命令执行改动无关。
- 事件所有权第一批：业务事件已从 Turn 回到各自模块，`src/events` 只组合生命周期通道；TTS 与 Artifact 警告不再伪装成 System 事件。离线刷新 Workspace 后全仓 typecheck 84/84；Agent 32/32、Context 23/23、Hooks 27/27、TTS 61/61、Core 92/92、Desktop UI 132/132 通过，4 个 Agent Live Integration 按既有规则跳过。
- AgentLoop 与 agentContext 收口：Tools build 通过，Tools/Agent/Core typecheck 通过；Agent 32/32 通过，4 个 Live Integration 按既有规则跳过；FileWriteTool 7/7 通过。Workspace lockfile 已离线刷新为 44 个项目，`@ema-agent/agent-context`、`turnLoop`、`loop_done`、`IFileStateStore*` 源码引用归零。
- TurnRuntime/AgentLoop 与事件范围文档更正：`CLAUDE.md`、`EmaWorkState.md`、`EmaRefactor.md`、`EmaClaudeArchitectureReview.md` 已统一口径；核心文档中的旧循环命名残留扫描为零，事件目标统一为 `AgentLoopEvent/TurnEvent/AgentRunEvent/SessionEvent/AppEvent`。该批只改文档，未运行代码测试；`git diff --check` 唯一报错来自其他 Agent 的 `src/sandbox/shell-probe.ts` 既存尾随空格。
- AgentRun 前端命名与协议收口：Desktop UI 31 个测试文件、132 项测试全部通过，Core 30 个测试文件、92 项测试全部通过；Desktop UI 与 Core typecheck 通过；新增 AgentRun Store 2 项测试覆盖原生快照和加载/SSE 竞态，Core 2 项路由测试覆盖原生身份与 transcript 字段。
- Task/Diff 输入框状态条：Desktop UI 30 个测试文件、130 项测试全部通过；Desktop UI typecheck 通过；新增 Task Store 2 项测试覆盖快照/事件合并与并发旧响应重读。
- Chat 长历史前端：Desktop UI 29 个测试文件、128 项测试全部通过；Desktop UI typecheck 通过；TurnRail 新增 4 项纯模型测试覆盖容量、时间顺序、邻域对称衰减和当前 Turn 高亮。
- Chat 长历史读取链：Storage 新增测试 3/3、Session 32/32、Core 新增路由测试 3/3 通过；Storage、Session、Core typecheck 通过。`EXPLAIN QUERY PLAN` 已确认 Turn 复合游标命中 `idx_turns_session_latest`；`git diff --check` 通过，仅有既有 CRLF 提示。
- Session Branch 删除批次：Session 34/34、Storage 116/116、Desktop UI 124/124 通过；Session/Storage/IDs/Backup 构建通过，Core 与 Desktop UI typecheck 通过。Data v19 验证 Branch 表及列已删除，Session/Turn 身份不可变触发器仍生效；`git diff --check` 通过，仅有既有 CRLF 提示。
- V1 Task 后端批次：Data v18、TaskStore/依赖/CAS、AgentRun 可选绑定、TaskCreate/Get/List/Update、结构化事件、Work Context 提醒、`/api/tasks` 快照及 ZIP 备份恢复完成；聚焦测试 Storage 22/22、Tasks 1/1、BuiltinTools 8/8、Agent 2/2、Backup 10/10、Core 2/2 通过，全仓 typecheck 84/84 通过。
- AgentRun 语义批次：全仓 typecheck 82/82 通过；Storage 116/116、Agent 32/32、Tools 25/25、Backup 10/10、Core 85/85 通过。BuiltinTools 51/52，唯一失败仍是既存 WebFetchPolicy 的 `example.com -> www.example.com` 重定向口径，与本批无关；本批新增与改写的说明注释已统一为 UTF-8 中文。
- Multi-Agent 与 Task 边界已按 Claude 源码复核：普通 Subagent 不共享 Task Tools，只有 Team teammate 才有 owner/自主领取语义。Ema V1 已冻结为根 Turn 管理 Task、AgentRun 可选关联既有 Task、Run 终态不自动改变 Task 终态；本批只改文档，未运行代码测试。
- V1 Task 文档口径审计完成：核心架构文档、CLAUDE、Sandbox 评审、Bug 总表、Storage README 与 Batch 历史入口均已区分 Task/AgentRun/BackgroundProcess/Job；旧待定措辞和错误的后台进程工具命名残留扫描为零。该批只改文档，未运行代码测试；`git diff --check` 通过。
- 根 `src` 与 Workspace 目录审计完成；`packages` 仅剩 `credential`、`public-http`。
- `pnpm install --offline` 已刷新迁移后的 Workspace 链接。
- 全仓 typecheck 最近结果：84/84 通过。
- 中央 Contracts 已删除，`@ema-agent/contracts` 生产与测试引用归零。
- 旧产品 `packages/...` 路径审计为零。
- 新 Turn 契约完成后，`@ema-agent/turn` build 通过；Agent、Core、Desktop UI typecheck 通过。
- Agent 测试 32/32 通过，4 个 Live Integration 测试按既有规则跳过。
- Tool Result 与来源契约批次：Tools 21/21、MCP 25/25、Agent 32/32、Context 23/23 通过；BuiltinTools 与 Core typecheck 通过；全仓 typecheck 最近结果 84/84 通过。
- ToolExecution Journal 所有权批次：Tools 25/25、Tasks 3/3、Agent 32/32（4 个 Live Integration 按规则跳过）、Storage 119/119、Core 89/89 通过；全仓 typecheck 84/84 通过。
- Core 测试 88/88 通过；Desktop UI 测试 128/128 通过。
- Data v15 与 Profile v10 迁移通过：Session/Turn 新字段已落盘，Provider 和 Session/Turn 遗留列已物理删除。
- Storage 测试 118/118、Session 测试 39/39、Backup 测试 10/10 通过。
- Chat/Work 前端切换批次：Turn、Session、Contracts build 通过；Agent、Conversation、Core、Desktop UI typecheck 通过。
- 本批 Core 测试 88/88、Desktop UI 测试 130/130、Session 测试 39/39、Agent 测试 32/32、Conversation 测试 7/7 通过；4 个 Agent Live Integration 测试按既有规则跳过。
- Prompt 新边界：Prompt 测试 6/6、Skills 测试 21/21、Core 测试 88/88、全仓 typecheck 84/84 通过。
- Prompt 分层请求：Prompt 6/6、Context 21/21、LLM 126/126、Skills 23/23、Agent 32/32、Conversation 7/7、Core 88/88 通过；Agent 4 个 Live Integration 按既有规则跳过。
- Context 请求尾缓存断点：Context 21/21、LLM 127/127 通过，两个模块 typecheck 通过。
- Compaction 新语义与 Safe Cut：Context 23/23、Memory 20/20 通过；Turn、Context、Memory、Core、Agent、Conversation typecheck 通过。
- Prompt/Context V1 目录规范：Prompt 6/6、Context 23/23、Memory 20/20 通过；Prompt、Context、Memory、Agent、Conversation、Core typecheck 通过。
- `git diff --check` 通过，仅有仓库既有的 Windows CRLF 提示。
- Contracts 第一批回流：Core 与 Desktop UI 依赖构建通过；全仓 typecheck 84/84；Core 88/88、Session 39/39、Backup 10/10、Desktop UI 130/130 通过；Builtin Tools 中本批相关 FileWriteTool 7/7 通过，仍有既存 WebFetchPolicy 1 项失败。
- Contracts 消息统一：Core/Desktop 依赖构建与全仓 typecheck 84/84 通过；Session 43/43、Context 23/23、Conversation 7/7、Agent 32/32、Core 88/88、Desktop UI 130/130 通过；4 个 Agent Live Integration 按规则跳过。
- Contracts 待修收口：`pnpm install --offline` 与全仓 typecheck 84/84 通过；Storage 119/119、Session 44/44、Context 23/23、Core 89/89、Desktop UI 130/130 通过；`git diff --check` 仅有既有 CRLF 提示。
- Contracts 错误回流：全仓 typecheck 84/84；Hooks 27/27、Conversation 7/7、Agent 32/32、Core 89/89 通过；4 个 Agent Live Integration 按既有规则跳过。
- Contracts 外壳删除：Workspace 已刷新为 44 个类型检查模块；全仓 typecheck 84/84 通过，`@ema-agent/contracts` 生产与测试引用归零。
- 旧 Mode 与 Memory/Narrative 分区清理：全仓 typecheck 84/84；Hooks 27/27、Memory 20/20、Session 44/44、Conversation 7/7、Agent 32/32、Core 89/89 通过，4 个 Agent Live Integration 按规则跳过；Storage 118/119 后唯一偶发失败的 KB lease 测试单独重跑 3/3 通过；旧 `TurnMode/legacyMode/lastMode/modeCounts` 源码引用归零。

## 工作规则

- 每次开始先读本文件，再看相关源码、测试、`git status` 和当前 Diff。
- 纯历史描述不作为当前实现证据；源码、测试与最近验证优先。
- 禁止覆盖其他 Agent 的未提交修改；同文件重叠先审 Diff。
- 新文件用 camelCase；相对 import 保留 `.js`；中文注释使用 UTF-8。
- 禁止行内动态 import、`any`、万能 meta、无意义 Facade/Manager/Service 和大量几行碎文件。
- 开发期可以删除已经失去业务意义的旧测试，但不能为了让错误实现通过而删测试。
- 不执行 `git add`、commit、push，除非用户明确要求。

## 恢复提示

```text
继续 EmaAgent V1 语义大重构。

先完整阅读 CLAUDE.md 与 EmaWorkState.md，再按当前批次阅读 EmaRefactor.md 和 EmaClaudeArchitectureReview.md 对应章节。检查 git status、diff 和最近提交，保留用户及其他 Agent 的修改。

目录迁移已经结束，不要继续机械搬包。R2 Prompt Slot 与 R3 ContextAssembler 已完成，不要重写。当前从统一 TurnRuntime/AgentLoop 主线推进；现有 AgentEngine 是迁移基础，不新增第三套 Engine。修改前先核对真实调用链并说明本批边界，不要提交 Git。
```

## 维护方式

每完成一批，只更新当前阶段、工作区归属、最近验证、下一步和阻塞项。讨论过程与长篇原理写入对应 RFC/评审文档，不复制到本接力板。
