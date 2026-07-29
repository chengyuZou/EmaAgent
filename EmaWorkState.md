# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-07-29
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。统一执行主线第三刀已经完成：Chat/Work 都通过 `TurnExecutor.start() + AgentLoop` 执行，`TurnExecutor` 同步创建根 Turn 并返回单消费者、有界反压的 `TurnHandle`；执行 Profile 只控制迭代预算与模型可见 Tool Manifest，不再选择另一套 Engine。低层 `@ema-agent/turn` 继续只拥有根领域契约，不建立泛化的 Orchestrator、Runtime 或第三套 Engine。

LocalHost L0 纯改名已经完成：`apps/core`、`@ema-agent/core`、`ema-core` 及发布资源身份统一为 `apps/localHost`、`@ema-agent/local-host`、`ema-local-host`；Tauri RuntimeService、readiness、externalBin、发布脚本、CI 与文档已经同步。该批没有迁移 Route、Orchestrator、wiring 或业务职责，下一批进入 L1 Turn 输入准备归位。

L1 Turn 输入准备已经完成：`TurnInputPreparer` 统一完成一次根 Turn 的附件持久化与媒体兼容、模型选择与能力快照、Prompt 快照、Workspace 和 Scratchpad 纯值准备；`TurnInput` 不携带回调、Runtime、Repo 或可变依赖，模型能力也不会在执行阶段再次解析。旧 `TurnExecutionPlan/PreparedTurnExecution` 已删除，LocalHost Orchestrator 不再实现第二套输入准备。目标继续保留低层 `turn`、用例层 `turnExecution` 和进程宿主 `localHost` 三层；不建立新的万能依赖袋或第二套 Orchestrator。

L2 Turn Context 已经完成：`TurnContextBuilder.prepare()` 一次性建立历史兼容视图和 Narrative/Memory/Task 临时贡献，返回的 `TurnContext` 在每次 LLM Call 通过现有 `ContextAssembler + ContextCompactor` 重建不可变窗口；Scratchpad、Mailbox 与 Active Skill 只作为当次投影输入。`TurnExecutor` 不再直接读取 Context 内部接口，LocalHost 也不再手写 Contribution/Compaction 回调。Memory 新增所有者定义的窄 `MemoryRecallPort`，召回证据与 Context 压缩事件进入当前 Turn 事件流，不再只发到进程级总线。

L3 Turn Tools 已经完成：`TurnToolsBuilder.prepare()` 在根 Turn 开始时一次冻结 Capability Context、Builtin/MCP Manifest、Execution Profile 与 Tool Policy，并绑定 KB/Narrative/AskUser/Skill/Task/Sandbox 等窄能力；`TurnTools` 统一拥有 ToolExecutionRuntime、SubagentSpawner、Active Skill 与终态关闭顺序。`TurnExecutor` 不再读取 Tool Registry、Permission、CommandRunner、Journal 或 AgentRun Store，只通过一个 Turn 级协作者执行、取消和收口工具。

L4 Root Agent Execution 已经完成：`RootAgentExecution` 统一拥有根 AgentLoop、Context/Tool 一次性组合、LLM/Message Hook、Emotion、非终态事件翻译与 transcript 持久化，只返回 `completed/failed/aborted` 结构化结果；它通过 `RootAgentTranscript` 窄端口写消息，无法创建或提交根 Turn 终态。`TurnExecutor` 只保留根身份、TurnHandle、准备期、Turn 生命周期 Hook、取消、交互清理、临时目录清理与唯一终态；`TurnExecutionDeps` 只有 Session、Hook 与根 Turn 交互清理三个明确依赖。单次迭代块顺序由内聚的 `IterationTranscript` 共享给 Hook 和持久化，不在两个层级重复重建。

L5 Turn Composition Root 已经完成并提交：`apps/localHost/src/wiring/createTurnExecution.ts` 是根 Turn 输入准备、Context、Tools、RootAgentExecution 与 TurnExecutor 对象图的唯一构造位置。LocalHost Orchestrator 只取得 `TurnInputPreparer + TurnExecutor` 两个明确入口，不再知道 Agent 执行链如何装配；TTS 合流、Route 与大型 AppBindings 本批未动，避免把多个业务边界混成一次机械搬家。L5 是根 Turn 执行地基的最后一层，后续不再创建 L6 或另一套执行抽象。

L5 后第一批 TTS Turn 输出边界已经完成：`src/tts/turnOutput.ts` 现在装饰 `TurnHandle.events`，把文本增量交给 `TtsCoordinator`，成功时在根终态前完成音频归档，失败/取消时丢弃音频；TTS 初始化和音频统计投影失败只产生 TTS warning，不改变根 Turn 终态。Provider 声音上传结果已经从 Settings/SQLite 移出，由 `src/tts/voiceHandle.ts` 按角色、Provider 配置和模型在当前进程内短期复用；协议没有明确持久化保证时默认两分钟失效。LocalHost `createTurnOutput.ts` 只装配模型 binding、全局角色语音、路径与共享内存缓存。旧 Orchestrator 的 TTS 合流、Route 音频投影回调和易丢唤醒的手写 Promise 信号已删除。

L5 后第二批根取消与旧 Orchestrator 删除已经完成：`TurnExecutor.abort(turnId)` 通过 Session 现有运行注册表核对历史 Turn 是否仍为当前活动 Turn，`TurnHandle.abort()` 和事件消费者关闭也走同一精确入口，陈旧句柄不会按 Session 误杀下一轮。Turns Route 直接使用 `createTurnExecution()` 返回的 `TurnInputPreparer + TurnExecutor` 启动根 Turn，再通过 `createTurnOutput()` 装饰事件；LocalHost `activeTurns`、重复请求类型与整个 `orchestrator` 文件已经物理删除。

L5 后第三批 Route 业务副作用归位已经完成：`AgentRunTranscriptProjection` 位于 `src/agent/runs`，`SubagentSpawner` 在 AgentRun 事件产生处写入 transcript，并把辅助落库失败转换为父 Turn warning；是否存在 HTTP/SSE 消费者不再影响落库。`TurnExecutor` 通过窄 `TurnInteractionCleanup` 在自身 `finally` 中清理该 Turn 遗留的 Permission 与 AskUser，准备失败、成功、失败和取消使用同一条路径。Turns Route 只保留事件存储、在线发布和传输控制，不再监听终态执行这两类业务副作用。

AppBindings 收窄第一子批已经完成：`tasksRoute` 只接收 Task 查询所需的 `TaskStore` 方法，`agentRunsRoute` 只接收 AgentRun 管理方法和 transcript 读端口，两个 Route 对 `AppBindings` 的引用归零。`AgentRunTranscriptStore` 统一承担持久事件追加与 SQLite 行到领域 transcript 的映射，HTTP 不再解析 `content_json`；完整对象图仍只在 `server.ts` 与 wiring 装配边界展开。

Turn Route 收窄与目录内聚已经完成：原 430 行 `routes/turns.ts` 按启动、SSE、音频、工具审计、取消和 AskUser 拆入 `routes/turns/`，所有 `/api/turns/*` URL 保持不变。`wiring/createTurnsRouter.ts` 是 Route 对象图的装配入口，完整 `AppBindings` 不再进入 Turn HTTP 文件；各端点只接收 Session、附件、交互队列、工具日志、音频或 TurnExecutor 的窄投影。统一交互队列新增原子的 `cancelPermission/cancelAskUser`，两个 HTTP 入口不能再用另一种交互的 `promptId` 跨类型取消。

Permission Route 收窄已经完成：`permissionRoute()` 直接接收 PermissionEngine 的规则 CRUD 投影与统一交互队列的 Permission 响应、取消、快照投影，不再接收 `AppBindings`。`server.ts` 作为 HTTP Composition Root 显式传入两个现有对象，没有为两行转发新增工厂或嵌套依赖袋；所有 `/api/permission/*` URL、状态码和前端协议保持不变。

Session Route 收窄已经完成：原 `routes/sessions.ts` 按集合、历史、附件、动作和标题拆入 `routes/sessions/`；所有 `/api/sessions/*` URL 与前端协议保持不变。标题 Prompt、模型失败回退和持久化进入 `SessionTitleGenerator`，工作区变更后的 Runner 失效及永久删除前的交互、授权、运行时清理进入 `SessionLifecycle`；HTTP 文件只接收各自使用的 Session、Attachment 和文件句柄窄端口，完整对象图只在 `wiring/createSessionsRouter.ts` 展开。

Provider/ModelBindings 控制面收窄已经完成：原 784 行 Provider Route 按配置、模型池、六种能力探测和 TTS 试听拆入 `routes/providers/`，模型绑定查询与变更拆入 `routes/modelBindings/`；URL 和响应协议保持不变。Provider 配置、探测与模型绑定原子变更由 `src/providers` 拥有，TTS 试听由 `src/tts` 沿正式执行面完成；HTTP 只做解析和映射，完整对象图只在两个 `wiring/create*Router.ts` 展开。Profile v13 将模型绑定的通用 `config_json` 和未消费 `voice_id` 收口为明确的 `embedding_dimension`，Bridge 不再猜测 JSON 字段。

事件通道同步完成消费者迁移：Turn SSE 使用 `TurnStreamEvent`，系统 SSE 使用 `AppEvent`，只有跨端通用解码器使用 `ClientEvent`；`EmaStreamEvent` 仅剩 `src/events` 内的弃用兼容声明，生产代码与应用测试不再导入它。Task 更新明确属于 Turn 输出联合，Memory 进程级依赖只允许发送 `MemoryBackgroundEvent`，召回证据继续进入当前 Turn。

Settings/Theme 配置所有权与 HTTP 边界已经完成：用户设置继续使用 `profile.db.settings` 作为唯一持久化源，Storage 只提供纯 KV Repo；`src/settings` 直接消费 `SettingsRepo`，统一定义、Catalog、内存快照、提交顺序与变更事件，没有复制镜像持久化接口。Agent、Context、Permission、Attachment、Vision、Knowledge 与 Theme 已各自拥有显式设置定义，由 LocalHost Composition Root 聚合；既有 Event Display、Permission Timeout、Theme 与 KB Model URL 保持原 HTTP URL，并返回后端规范化后的持久值。Desktop Theme 支持先预览、保存失败回滚。TTS 上传句柄等供应商运行时缓存不属于用户设置，已退出 `profile.db.settings`。下一批按业务逐项接入仍未消费的新参数，不能把“已注册定义”误写成“运行时已经生效”。

Settings 运行时接线第一批已经完成：Catalog 新增稳定键查找，LocalHost 提供通用 `/api/settings/values/:key` 读写入口，所有写入继续经过业务定义的 decode 与 SQLite 后快照提交顺序。`agent.limits` 与 `context.compaction` 在 `TurnInputPreparer` 中只读取一次并冻结为根 Turn 设置快照；Agent 迭代、Tool/Subagent 预算和每次 Context 压缩都读取该快照，运行中的 Turn 不受后续设置更新影响，全局 `ContextCompactor` 也不保存并发 Session 的可变用户值。

Settings 运行时接线第二批已经完成：`attachments.limits` 在附件写入、图片数量/体积校验和 Vision 降级前随根 Turn 冻结，同一 Turn 不会混用新旧值；超限输入改为明确失败，不再静默截掉附件。图片规范化使用该快照的字节和长边上限，派生缓存配额在每次空闲清理开始时读取一次。`vision.limits` 则按 `nextOperation` 语义在每次 extract/probe 开始时取得一份已校验快照，排队及执行中的请求不会被后续设置变更改写。

L5 后余下 Route 收口已经完成：Transcribe 只接收 STT 执行面与模型绑定查询，Cards 只接收角色卡 Store，Shell 只接收 Permission 审批入口；Knowledge Base 与 Storage Stats 使用按业务命名的明确依赖集合。五组 Route 和对应测试不再导入或伪造 `AppBindings`，完整对象图只在 `server.ts` 与 `wiring/create*Router.ts` 等 Composition Root 展开，URL、状态码和响应协议保持不变。

LocalHost HTTP 传输边界第一刀已经完成：`server.ts` 只接收有序 `MountedHttpRoute[]`，统一处理 CORS、认证、请求预算、挂载、404 与异常协议，不再导入任何业务 Route 或 `AppBindings`。`wiring/createHttpRoutes.ts` 是当前唯一 HTTP Router 注册表，各 Router 仍在 Composition Root 取得自己的窄依赖；所有 URL 与协议保持不变。字段审计删除了装配完成后无消费者的 `profileDb/credentials` 运行期成员，根包也停止公开宽 `AppBindings/wire/createTurnExecution/createTurnOutput` 装配 API。

LocalHost 后台生命周期已经完成收口：`BackgroundWork` 统一管理进程启动后的 Memory/MCP 初始化、周期维护、Tool Result 与 Attachment Cache 清理、Bridge 心跳和有序关闭；`StartupRecovery` 在新 Worker 启动前恢复中断的 Tool、Memory、Turn、Turn 文件和 AgentRun 状态。`wire()` 现在只构造对象图并注册 Hook/Emitter，不再因构造绑定而执行崩溃恢复；后台专用清理器也已退出 `AppBindings`。关闭顺序固定为停止新 tick、等待在途初始化、排空 Memory、等待 MCP 启动收口并断开连接。

LocalHost 一次性启动装配已经完成收口：`bootstrap/startLocalHost.ts` 先幂等补 Marketplace 内置源和默认 KB，再启动恢复与常驻后台，最后并行发起 KB 索引、Skill 对账、models.dev Catalog 和首次 Bridge 配置；除默认 KB 外均保持失败只降级对应能力。`buildBindings()` 不再启动 Skill/Catalog 或写 Marketplace Seed，进程入口也不再逐项知道 KB、Bridge 和后台任务。角色卡 Seed 仍是 Character/Emotion 对象图的同步构造前置：EmotionEngine 立即需要活动角色，且角色卡写入受 Live2D 模型外键约束，不能伪装成可延迟后台任务。

LocalHost Composition Root 拆分计划已经冻结：轻量对象统一 eager 构造，真正的网络、文件、KB Client、MCP Transport 和 Skill 资源按 Operation 或资源 lazy；启动失败分为阻止 ready 的 `fatal`、禁用单项能力的 `degraded` 与仅影响单次调用的 `feature-local`。计划同时明确后台 Promise 必须由 Lifecycle 跟踪、核心 Turn/ToolExecution/AgentRun 恢复失败不得被清理 catch 吞掉、Memory 恢复失败时不得继续 Worker、默认 KB 目标改为可降级。施工计划位于本地忽略目录 `docs/architecture/localHostWiringRefactorPlan.md`。

LocalHost Composition Root 第一批已经完成：`createProviderControlPlane.ts` 统一构造 Provider 仓库、模型绑定、六模态模型池、models.dev Catalog 与能力解析器，并保证旧明文凭据迁移先于任何 Provider 配置读取；`createModelExecution.ts` 统一构造无 Session 状态的 LLM/Embed/Rerank/Vision/STT/TTS、Narrative、Usage、音频归档与 Provider 刷新入口。`bindings.ts` 立即解构两个工厂结果，`AppBindings` 继续保持现有平面协议，没有新增嵌套依赖袋。内置 Catalog 快照同时支持源码与 dist 资源路径，空/坏快照不会清掉已有目录或伪装成加载成功；后台刷新增加 10 秒取消信号。

LocalHost Composition Root Session/Memory 批次已经完成：`createSessionPersistence.ts` 统一构造 Session 聚合、统计与会话笔记入口，Memory、Session Dashboard 和 Backup 不再分别创建指向同一张表的 `SessionNotesRepo`；`createMemoryRuntime.ts` 只构造 Memory Planner 与两库 Repo，不启动索引或 Worker，`initialize/tick/drain` 继续由 `BackgroundWork` 管理。`ContextCompactor` 已退出 `AppBindings`，由唯一根 Turn 对象图 `createTurnExecution.ts` 构造并持有，不进入 Memory 工厂，也不按 Turn 重建。Route、恢复、后台和前端协议均未改变。

LocalHost Composition Root Attachment/Backup 批次已经完成：`createAttachmentRuntime.ts` 统一构造附件记录、共享派生缓存 Repo、图片派生缓存与空闲维护器，构造期不创建目录、不规范化图片也不启动清理；缓存配额仍在每次真实 sweep 开始时读取一次。`createSessionBackup.ts` 复用同一 Session、统计、会话笔记和 Attachment 入口建立 `SessionBackupFacade`，ZIP 校验、文件提交与事务恢复语义不变。`bindings.ts` 不再展开 Attachment/Backup 内部对象图，Route、后台时序和前端协议均未改变。

开工前已复核本地 Codex 源码：`codex-protocol` 只定义 Thread/Turn/Submission 等低层协议，真正编排位于 `codex-core/session`；App Server 只校验并提交 `Op::UserInput`，Session 统一建立 `RunningTask`、取消句柄和终态，`RegularTask` 再调用内部 `run_turn` 完成多轮模型与工具循环。Ema 因此保留低层 `turn` 与高层 `turnExecution` 两个编译边界，不能把执行依赖反向塞进被 Context、Session、Storage、Hooks 共同依赖的领域包。

旧 `ConversationEngine` 与整个 `src/conversation` 包已经删除，Workspace 依赖和生产 import 归零。Chat 根生命周期与只读 Tool Profile 进入 `turnExecution`，LLM/Tool 迭代进入 `agent`，Narrative Route 与多周目 Recall 回到 `narrative`，模型可见召回正文通过不可信 Context Contribution 投递；Hook 不再携带 Narrative 私有结果。

Narrative R4 已经完成：`auto` 只在本轮 Tool Context 注入 NarrativeSearchPort，由模型按需调用稳定 ID 的 NarrativeSearchTool；`always` 继续在 Turn 开始时主动召回；`off` 不暴露工具也不召回。Port 在 TurnExecutor 绑定 Session/Turn、SSE 与 `narrative_context` 持久化，Tool 只接收窄查询能力；Route 与 LightRAG 继续使用 Narrative 自有 `lightrag-llm` 绑定，不读取当前 Chat/Work 模型。

事件所有权第一批已经落到源码：Agent、Characters、Context、Hooks、Knowledge、Memory、Narrative、System、Tasks、Tools 与 TTS 各自拥有 `events.ts`；Turn 只保留根生命周期、输出、Usage 与请求降级事件。`src/events` 像 `src/ids` 一样执行严格准入，但只负责组合 `TurnStreamEvent/SessionEvent/AppEvent`，禁止定义业务字段。`EmaStreamEvent` 已标记为迁移期兼容名，新生产者必须使用领域事件或窄通道事件。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

Prompt 装配边界已经完成新语义收口：公共入口只接受全局 Active Character、`ExecutionProfile`、`NarrativePolicy` 与显式扩展贡献；旧 `buildSystemPrompt`、`buildModeBlock`、`legacyExecutionProfile` 和工作区路径注入已删除。Prompt 源码不再依赖 `contracts`，Skill Catalog 只在 Work Profile 作为扩展 Context 提供。运行时历史、召回、附件和工作区事实继续由 Context 所有。

Prompt 缓存边界已进一步落到真实模型请求：稳定范围改为 `product / activeCharacter / turn`，全局激活角色不是 Session 绑定；产品规则与全局角色各自形成 System Block 和缓存断点，Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部。Skill Catalog 作为普通 Context Message 投递并限制为 8000 字符总预算、250 字符单项描述，不能取得 System 权限。Context 会冻结日期、平台、工作区和模型身份，并输出分层 Prompt Revision、Tool Manifest Revision 与 Prefix Hash。Anthropic Adapter 已支持保留多层 System Block，不再由后一条覆盖前一条。

Context 的缓存链已经补齐请求尾部断点：最终模型请求的最后一条非空消息会获得仅存在于只读投影中的动态 `cacheBreakpoint`，历史和已完成 Tool Round 因此能够进入下一次调用的缓存前缀；该标记不写回 Session、Turn 工作消息或压缩历史。

Compaction 已迁出旧三 Mode：摘要结构只由 `ExecutionProfile = chat | work` 决定，`NarrativePolicy` 随事件保留但不选择第三套模板。Macro 使用可丢弃的 `<analysis>` 草稿提升摘要质量，只把 `<summary>` 写入上下文；Safe Cut 已合并为按 `toolUseId` 检查整段 tail 的单一算法，支持工具消息之间插入附件，同时阻止孤立 `tool_result`。

Prompt/Context 的 V1 目录边界已经规范化：`contextSnapshot.ts` 独立拥有单次模型调用的不可变输入、输出与缓存诊断，`types.ts` 只保留 Contribution 和压缩协作契约；`slots.ts` 独立拥有 Slot 身份、顺序、稳定范围、投递方式与信任级别。Context Contribution 公共请求已移除 `TurnMode`，直接使用 `ExecutionProfile + NarrativePolicy`；Memory 公开召回入口接收新契约，旧检索分区的临时映射收回 Memory 内部。

统一 Turn 主线的内层循环已经完成：公网请求使用 `trigger + executionProfile + narrativePolicy`；`runAgentLoop()` 同时服务根 Agent 与 Subagent，只管理 LLM、Tool、Result 迭代。循环不再依赖 `EmaStreamEvent`，执行器事件通过泛型交给外层翻译；完成结果通过唯一 `AgentLoopOutcome` 返回，不再伪装成 `loop_done` 流事件。Session/Turn SQL 显式保存触发来源、执行 Profile 与 Narrative 策略；Desktop 顶层选择器只显示 Chat/Work，Narrative 使用 `auto/always/off` 二级策略。

Provider 配置也已完成旧列清理：顶层 `base_url`、`config_json`、`capabilities_json` 被物理删除，地址、协议和能力开关只保存在 `provider_capability_configs`。Session/Turn 无业务读取的 `meta_json` 同步删除；Message、MCP 等仍有明确用途的 JSON 未动。

Contracts 第一批所有权回流已经完成：`agents.ts`、`sessionOwnership.ts`、`kb.ts`、`capabilities.ts`、`wire.ts` 已删除。Agent 初始化种类归 Turn 事件边界，工具执行审计归 Tools/Storage，知识检索结构归 Knowledge，Session 归属校验与 REST DTO 归 Session，发布能力、沙箱状态和备份警告分别归 System、Sandbox、Backup。数据形状和运行语义未改变。

Contracts 消息契约也已收口：`contracts/messages.ts` 和 `ids.ts` 中的 `MessageRole` 已删除。LLM 继续独立拥有纯模型消息；Turn 拥有请求媒体、附件输入与 Tool 展示协议；Session 拥有持久化 MessageBlocks、Narrative Block 及 UI/审计扩展字段；Storage 拥有数据库 `MessageRole/MessageKind` 枚举。Session 读取 `blocks_json` 时现会按 role/kind 校验，损坏内容不再原样暴露。

消息待修项已经收口：本轮模型调用仍可临时使用 Base64，但写入 `messages.blocks_json` 前会删除图片、音频和文件正文，磁盘附件改为 `attachment_ref` 稳定引用；历史模型窗口只得到明确占位，不会静默重读旧文件。Data v16 已物理删除从未被业务读取的 `messages.meta_json`，Fork 与备份恢复 SQL 同步移除该列。

Artifact 已物理删除：`src/artifact` 模块、ArtifactStore/ArtifactRepo/ArtifactEvent/IArtifactStore/ArtifactWrite/Read/List 工具、`@ema-agent/artifact` 依赖、`artifacts` 表、相关触发器与索引、备份导出/恢复分支、Desktop UI 面板与 Store、`ReleaseFeaturesWire`/`artifactsEnabled` Feature Gate 和无消费者的 capabilities 空壳端点均已删除。Data v21 执行 `DROP TABLE IF EXISTS artifacts`；启动恢复清理旧 Session 的 `artifacts/` 目录，旧 Artifact ZIP 使用明确的不支持错误拒绝。代码文件统一由 FileWrite/FileEdit + Diff/Review 处理。

附件与格式化文档读取第一批已经完成：新增独立 `PdfReadTool`，复用 Knowledge 的 PDF Reader 并只解析显式页范围，不建立万能 `DocumentReadTool`；未来 DOCX、PPTX、表格继续各自拥有格式专用 Tool。图片进入 Vision 降级前会统一方向、缩放、转 WebP 并移除 EXIF/GPS，再按规范化内容哈希、任务、Provider 配置、模型与 Prompt 版本复用派生描述。内存 LRU 只保存文本，持久缓存把规范化图片和派生文本放在同一内容寻址目录；Data v22 只保存缓存索引。后台每 30 分钟尝试维护，但仅在没有活动 Turn 且距上次维护至少 6 小时时执行，不在每次启动扫描缓存。

Contracts 错误所有权已经收口：中央 `ErrorCode` 改为 Turn 拥有的 `TurnFailureCode`，只描述当前确实可能通过 `turn_failed` 暴露的 11 个终态码；LLM、Vision、STT、Narrative、Knowledge 等继续保留各自领域错误。无生产者的旧 Auth、Tool、Memory、Narrative、Storage、TTS/STT 与 System 占位码已删除，`contracts/errors.ts` 不再存在。

Contracts 外壳已经删除：跨业务边界共享的 branded ID 收口为零业务依赖的 `src/ids` 叶子模块，并通过准入规则禁止业务对象、状态、事件、错误和 DTO 进入。`TurnStatus` 已回到 Turn；旧 `TurnMode` 及 Session/Conversation/Hook/Core 的兼容投影已经删除，运行链直接使用 `ExecutionProfile + NarrativePolicy`。

Memory 与 Narrative 的旧分区也已经拆开：Memory 只按 `chat/work` 记录提取与召回范围，旧 `agent` 标签迁为 `work`、旧 `narrative` 标签迁为 `chat`；Narrative 继续作为独立 LightRAG Contribution，不再进入 Memory 类型和任务载荷。Profile v11 将 `memory_items.modes_json` 迁为 `profiles_json`。

Agent 执行体系第一批已经完成：Tool Result 外置与 Cleaner 从 `agentContext` 迁入 `tools/results`；`maxResultBytes` 和 200KB 聚合预算取代工具名白名单；MCP 动态工具通过统一 `buildTool()` 保留 Server JSON Schema 并继承 50KB 默认预算；`validateInput` 与 `requiresUserInteraction` 已进入真实执行链。`requiresUserInteraction` 只表达工具是否主动暂停 Turn 等待用户，不能被 Claude 的 `interruptBehavior = cancel | block` 替代；后者描述工具运行时收到新用户消息后的中断策略，等 TurnExecutor 统一插话和排队语义后再接。`ToolOrigin` 进一步把 Builtin/MCP 来源及原始 MCP 身份带入 Manifest 和 Prepared 快照，Registry 会拒绝来源声明与注册所有者不一致的工具。

Agent 执行体系第二批已经完成：ToolExecution Journal 从 Tasks 收回 `src/tools/journal`，Tools 现在拥有状态、领域记录、Store 端口、CAS 状态机与崩溃恢复语义；Storage 只实现原子 SQL 操作并把数据库行投影为领域形状；Core 从 Tools 装配 Journal，Agent 只依赖 `ToolExecutionJournalPort`。原 `IToolExecutionJournal` 已删除，Tasks 不再依赖 Tools/IDs 或导出工具执行生命周期。

Sandbox 依赖反转已经完成：进程启动、超时、取消和有界输出收回 `src/sandbox/processRunner.ts`，`CommandRunnerPort/CommandRunOptions/CommandRunResult` 只由 Sandbox 定义。Sandbox 不再依赖 Tools 或 Permission，也不从审批规则猜 OS 文件能力；Core 直接注入工作区、可写路径、私有路径和网络能力快照。Bash 删除裸 `spawn` 回退与假后台参数，无 Runner 时明确拒绝；无法进入现有 OS Sandbox 的 PowerShell Tool 已移除。无工作区不再回退 Sidecar 的 `process.cwd()`，子 Agent 当前本就不获得 Bash 能力。

Tools 主执行链归位已经完成：`ToolRegistry.dispatch()` 组合捷径已删除，可信测试调用同样显式使用 `prepare()` 与 `execute()`；原 Agent 内执行器迁为 `src/tools/execution/toolExecutionRuntime.ts`，统一承担并发栅栏、PreparedToolCall 校验、Permission、Journal、取消、结果预算和执行事件。Tools 通过窄 `ToolLifecycleObserver` 接受观察能力，不反向依赖 Agent、Session 或 Hooks；Agent 只负责把现有 HookBus 适配进来，并消费 `ToolExecutionResult` 决定下一轮。`ToolFailurePhase` 同步回到 Tools，Session 只扩展持久消息允许的媒体结果结构。

Permission 与 AskUser 的阻塞交互已经统一：`SessionInteractionQueue` 按 Session 串行 Permission/AskUser，跨 Session 并行，只有队首计时并允许用户响应；AskUser 回答、取消和超时使用明确终态，不再把取消伪装成空答案。四种纯问询工具通过随 `PreparedToolCall` 冻结的 `permissionMeta.approval = not_required` 跳过普通权限卡片，其余工具省略字段时默认 `required`。AskUser HTTP 响应同时校验 `promptId + turnId`，Turn/Session 中止仍可清理包括非队首在内的全部等待项。

Tool 调用边界已经收窄：旧万能 `ToolExecutionContext/ToolExecutionScope/ToolInvocationContext` 已删除。Ema 内置工具只在集成层共享一次执行的 `BuiltinToolContext`；每个 Tool 必须先用 `validateContext()` 校验并投影自己的窄 Context，`execute()` 看不到其他业务能力。ToolExecutionRuntime 只按调用覆盖 `toolCallId/signal/emit`，MCP 动态工具也使用同一四泛型契约。根 Agent 与子 Agent 先按实际 Context 装配 Manifest，再从同一 Manifest 建立 Policy；旧 Bridge 注册标志和子 Agent 手写白名单已删除。

Tool Port 所有权已经归位：Knowledge 与 Skills 分别公开 `KnowledgeSearchPort` 和 `SkillRunnerPort`，`SkillRunner` 直接实现后者，Core 不再维护重复的 `skillBridge` 适配对象；Sandbox、Tasks 与 Tools 文件状态继续拥有自身端口。Subagent 与 AskUser 的 Port 是 Builtin Tool 对宿主的消费契约，保留在 `builtinTools`，由 Agent/TurnExecutor 结构化实现，从而避免 `agent ↔ builtinTools` 或 `turn ↔ tools` 包环。通用 `tools/types.ts` 不再定义 Knowledge、Skill 或 Subagent 业务 Port。

Tool Manifest 缓存稳定性已经收口：Manifest 是模型工具数组顺序的唯一所有者，Builtin 按稳定内部 ID 形成连续前缀，MCP 按原始 Server/Tool 身份形成连续后缀；Agent 的 Skill 能力收窄只做集合交集，Context 只规范化 Schema key，二者都不再平铺重排工具。`registryVersion` 继续保护运行时快照世代，但不再进入内容 revision，因此等价 MCP 重连不会无故打断缓存，旧执行快照仍会明确失效。Skill/Profile 不是 Tool 来源，V1 不为插件或 Deferred Tool 预建类型。

Tool Presentation 公共协议已经收口：`src/tools/presentation` 拥有 FileChange/FileRead/Command/Search 的可判别联合与构造入口，`events.ts` 只引用总联合；FileEdit/FileWrite 的真实有界 Diff 已从 Builtin 私有 helper 迁入 Tools，FileRead、Glob/Grep 与 Bash 已接入实际读取范围、搜索数量和命令终态。模型提供的 Bash `description` 仍只用于 Prepared Call 的调用前解释，执行后 Presentation 只承载可信事实，两者都不参与 Permission/Sandbox 决策；未知 MCP V1 继续使用通用回退。

Skill/Subagent 内置工具契约已经收口：SkillCall 明确只加载当前 Agent 使用的指令并可收窄工具集合，不再宣称原子执行或绕过 Permission/Sandbox；普通 Subagent 默认使用 fresh 上下文，只有显式 `kind = fork` 才继承父历史。子 Agent 与父 Turn 共用工作区和受控 CommandRunner，但每个 AgentRun 拥有独立 `ReadFileState`；fork 只复制父读取快照，fresh 必须自行读取后才能编辑。根 Agent 新增 `SubagentAbort`，后台启动、消息、等待和取消统一使用 `agentRunId`，子 Agent 仍不获得 Task、AskUser 或递归启动能力。

Skill Runtime 已完成多文件 Bundle 与跨压缩恢复：`SkillRecord`、Catalog 摘要和激活快照都带明确的 `SKILL.md path`；Bundle 中每个实际文件拥有独立绝对 `path`、相对路径、用途、字节数和 SHA-256，整体 revision 按排序后的路径与内容摘要计算，正文与资源不常驻内存。每个根 Agent/AgentRun 独占 `ActiveSkillState`，fork 复制冻结快照、fresh 从空状态开始；SkillCall 仍只收窄 Tool 能力。正常迭代依赖原始 Tool Result，只有 Macro 真正改写历史后才通过结构化 `skills` Context Contribution 恢复激活指令，脚本继续显式经过 Bash、Permission 与 Sandbox。

Bash 纵深防御第一轮已经落地：静态分析、Permission 与 Sandbox 保持三层分离，危险磁盘操作和越界重定向硬拦，无法证明的替换/复合命令进入确认，Runner 结果补退出码语义。复查修正了双引号内 `$()` 仍会执行、引号包裹危险路径逃逸，以及 `git branch/tag/remote` 写操作被误判只读的问题；环境 allowlist 仍按既定计划留在 Sandbox 后续批次。

旧 `src/agentContext` 已完整删除：Tool Result 生命周期归 `src/tools/results`；Session 级近期文件快照已经删除，Work 压缩后按需重新调用 FileRead，编辑防覆盖只使用 Turn 内 `ReadFileState`。

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

当前主线工作区包含 LocalHost Composition Root 的 Attachment/Backup 对象图拆分：新增两个内聚工厂与聚焦测试，从 `bindings.ts` 移出 Attachment Repo、派生缓存和 SessionBackup 导出投影构造。工作区同时包含其他 Agent 正在进行的 Knowledge 检索设置与结果预算改动，本批只在现有 `bindings.ts` 改动上追加装配替换，没有回退或重写其业务逻辑。本地忽略目录 `docs/architecture/localHostWiringRefactorPlan.md` 继续作为施工计划。

当前基线最近提交：`bbd266e0 feat: implement Session and Memory architecture with persistence and runtime management; add tests for session handling`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是一次有明确触发原因与唯一终态的有界 Agent 执行；V1 只接用户消息触发。TurnExecutor 管根生命周期、身份、持久化、取消与唯一终态，AgentLoop 管一个 Turn 内重复的 LLM/Tool/Result 迭代。
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
- Artifact 已物理删除，代码文件由 FileWrite/FileEdit + Diff/Review 处理。

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
4. Tool Manifest 的 Builtin/MCP 稳定分区、内容 Revision 与缓存稳定测试（2C）已经完成；
5. Builtin Tool 2D 的 Sandbox 命令环境 allowlist、工作目录边界、FileRead 行数/字节双上限、Glob/Grep 有界搜索与 WebSearch 公网访问安全均已完成；结构化 Presentation 公共协议与首批接线已完成；
6. Permission V1 已完成：统一 Session FIFO、明确终态、Turn 身份核对、SQLite 永久规则 CRUD 与设置页管理、Builtin-only 免审批边界均已接通；旧 `AskUserRegistryLike` 已改为 `AskUserInteractionPort`，不新增第二套队列；
7. Skill 多文件激活、per-Agent 状态、结构化 Context 恢复与 `allowed-tools` 单向收窄已经完成；
8. LocalHost L0、Turn 输入准备 L1、Turn Context L2、Turn Tools L3、Root Agent Execution L4、Turn Composition Root L5、TTS Turn 输出边界、精确根取消与旧 Orchestrator 删除、Route 业务副作用归位及 Task/AgentRun Route 窄依赖均已完成；
9. Turn/AskUser、Permission、Session、Provider/ModelBindings、Settings/Theme、Transcribe、Cards、Knowledge Base、Storage Stats 与 Shell Route 已完成窄依赖；HTTP Server、后台生命周期和一次性启动装配也已完成收口。`buildBindings()` 的 Provider 控制面、六模态执行面、Sandbox/Tool、Session/Memory、Attachment/Backup 对象图已经提取；Character/Emotion 工厂仍由 K3 独立准备，主线下一批进入 Extension/Knowledge/Lifecycle，并先与其他 Agent 的 Knowledge 工作区对齐，不建立嵌套依赖袋或通用 `Lazy<T>`；
10. 后台进程按 `BackgroundProcess + ProcessOutput/ProcessStop` 单独实现 C 档，不修改 AgentLoop，也不恢复假 `run_in_background`；
11. 外围质量收口（K3 主线，依据为 2026-07-29 外围模块评审与 ragflow/claude-code 参照研究，管线对照见 `docs/reviews/ragflow-claude-pipelines.md`）：
    - **R2 KB 检索质量**：rerank 分数统一归一 [0,1]（已在区间内不动、越界才 min-max），rerank 替换制改为 RRF 分与 rerank 分的加权混合（消灭 0.4 硬门槛整条消失），空结果降阈值自动重查一次；
    - **R1 KB 摄入可靠性**：staging（原文上传即落盘，asset 只存位置与 content_hash）、hash 变更检测跳过重复解析、chunk id 幂等、digest 增量重跑、修复 `indexing` 窗口崩溃后的恢复死循环；
    - **R3 KB 模型集成安全**：检索结果加 untrusted 标注（对齐 NarrativeSearchTool 措辞）、`SearchOptions.maxResultChars` 显式预算与预算感知填充（低分 hit 降级为 citation-only），Tool 按上下文预算传参；
    - **R4 Memory 使用层**：`turnContext.ts` 召回包 try/catch 降级（对齐 Narrative 分支）、时间戳改"N 天前"、召回块加"可能已过时"标注、单条 body 长度上限；排在 turnExecution 施工空档；
    - **R5 Memory 提取信任**：提取要求引用原文举证（无引用丢弃）、CHAT 排除列表、未配置 memory 模型静默清空改显式事件；
    - **R6 Memory 判断层**：route-nodes 的 embedding 0.85 去重降级为"候选 + LLM 判定"，召回粗筛后加 LLM 精选（复用 memory binding，解决字面相近语义不同域的误判）；
    - **R7 Memory 溯源链**：L0 节点与 L1 摘要携带 source_id 指回 L2 事件/Turn，含 Data migration；
    - **R8 Skills 供应链**：bundle 资产全量哈希，市场清单携带 sha256，安装时强制校验；
    - **R9 Skills 收窄传播（语义已冻结）**：能力收窄按任务树继承——子 Agent 工具上限 = 父当前收窄集 ∩ 自身工具池，只能更窄不能更宽，与 TurnBudget 全树共享同原则；父 `TurnPolicy` 暴露 allowedIds，`SubagentSpawner.spawn()` 求交后建子 policy；
    - **R10 MCP 生命周期**：stdio 崩溃 onclose 感知、status 转 failed 与重连、live 发现的 schema 字节与工具数上限；
    - **R11 Memory 后台欠账**：stale embedding 修复任务落地（替换"只数不修"）、租约丢失时管道关闸防双写；
    - **R12 KB 模型变更生命周期**：embed 模型绑定变更时自动 `markStaleExcept` 并向用户提示或引导 reembed，消灭"换模型后旧文档向量静默退出 dense 检索"的漂移；chunk 参数若未来进设置，需按 claim 时冻结进任务（同 `resolveOptions` 模式）且 dedup 键扩展为 `hash(内容 + chunk配置)`（ragflow digest 语义）。
    - **A 主链真 bug**：ToolResultStore EEXIST 内容错位、Usage 状态模型补 `cancelled`、Anthropic 隐式 maxTokens=4096 改透传；
    - **B 主链安全收口**：install-git 与 mcpStdioGate 路由级审批修通、`AGEN_UNSAFE_*` 生产构建物理拒绝、Sandbox 状态接前端常驻提示；
    - **C 主链卫生**：agentLoopState 死声明清理（failed 相位、llm_error/user_timeout/user_cancel、pendingPromptId）、prefixHash 注释与行为对齐、压缩-恢复链字符串耦合改共享常量。

命名随业务批次清理：旧 `IFileStateStoreEntry/IFileStateStore` 及后续过渡接口已经删除，`IToolExecutionJournal` 已改为职责名；其余迁移期 `I*` 类型继续随业务边界处理，不单独进行全仓机械重命名。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

- KB 设置补全与模型集成安全（外围 R3）：Knowledge 12 个测试文件 60/60、LocalHost 37 个测试文件 133/133 通过；Knowledge、BuiltinTools、LocalHost typecheck 与 Knowledge build 通过。新增 `kb.retrieval` 设置（defaultTopK/alpha/rerankBlendWeight/resultMaxChars，`nextOperation`），`KbManager` 经 `resolveRetrievalSettings` 闭包每次操作读取（对齐 `resolveIngestOptions` 模式），显式 opts 优先于设置默认；`maxResultChars` 只由模型工具路径（bindings.kbSearch）显式注入，HTTP 面板不受影响。预算填充按分数从高到低消耗，第一个放不下的命中起全部降级为 citation-only 引用卡（保留出处与命中块预览），多 KB 合并后统一填充一次；rerank 混合权重改从 `SearchOptions.rerankBlendWeight` 读取。`KnowledgeBaseSearchTool` description 增加 untrusted 警示（对齐 NarrativeSearchTool 措辞）。新增测试覆盖预算填充四种形态、设置解码与越界拒绝、设置默认值/显式覆盖、合并后统一填充；`git diff --check` 通过，仅有既有 CRLF 提示。
- LocalHost Composition Root Attachment/Backup 批次：Knowledge typecheck/build 与 LocalHost typecheck、全量 37 个测试文件 133/133、正式 build 通过，构建验证 93 个源码、373 个产物；聚焦 6/6 覆盖 Attachment 构造期无文件副作用、缓存配额延迟读取，以及 Backup 从同一对象图导出消息、附件文件和会话笔记。Attachment/Backup 的 6 处具体构造均只存在于两个新工厂，`bindings.ts` 降至 636 行；`git diff --check` 通过，仅有既有 CRLF 提示。
- LocalHost Composition Root Session/Memory 批次：LocalHost typecheck、全量 36 个测试文件 131/131 与正式 build 通过，构建验证 91 个源码、365 个产物；聚焦测试覆盖 Session 永久删除后的派生目录清理、Session/Memory 共享同一会话笔记入口及 Memory 构造期不启动向量索引。`bindings.ts` 降至 661 行，ContextCompactor 生产构造只剩 `createTurnExecution.ts` 一处，SessionNotesRepo 在 wiring 中只构造一次；`git diff --check` 通过，仅有既有 CRLF 提示。
- LocalHost Composition Root Sandbox/Tool 批次：新增 `createSandboxRuntime.ts` 与 `createToolInfrastructure.ts`，`bindings.ts` 中的 Sandbox 探测/状态、per-Session Runner、Builtin Registry、Result Store、Cleaner、Task/AgentRun/Journal 构造已归零；工作区变更只失效 Runner，永久删除同时释放 Runner 与 Result Store，MCP 继续复用同一稳定 Registry。LocalHost typecheck、正式 build 和 35 个测试文件 129/129 通过，构建验证 89 个源码、357 个产物；8 项新测试覆盖 fail-closed/显式不安全开关、两类 OS Sandbox 状态、SQLite 文件族保护、Runner 缓存与淘汰、Tool Manifest 确定性和 Result Store 生命周期。
- KB 摄入可靠性（外围 R1）：Knowledge 11 个测试文件 51/51、LocalHost 35 个测试文件 129/129 通过；Knowledge 与 LocalHost typecheck、Knowledge build 通过。staging 落实 `{kb}/files/` 自包含设计意图：`stageIngestFile` 在 enqueue 时把原文复制进 KB 目录（文件名净化防穿越与 Windows 保留名），任务读取副本、`asset.filePath` 存 POSIX 相对路径，staging 失败在入队处直接 400 不产生必失败任务；`ingest/index.ts` 允许接管 `'indexing'` 崩溃残留（修复自动恢复必失败一次的死循环）；`KnowledgeClient.deleteAsset` 同步清理 staged 目录。新增测试覆盖源文件删除后任务仍成功、staging 失败拒绝入队、indexing 接管重建、删除文档清理副本；既有 ingest-queue 测试同步适配 async enqueue。contentHash 去重与失败分片增量重试经核实已存在，ragflow 页片 digest 复用不照搬；`git diff --check` 通过，仅有既有 CRLF 提示。
- KB 检索质量（外围 R2）：Rerank、Knowledge typecheck 与 build 通过；Rerank 6/6、Knowledge 10 个测试文件 47/47 通过，LocalHost typecheck（消费方）通过。rerank 分数在 `RerankRuntime` 出口统一归一 [0,1]（区间内原样、越界 min-max、全同越界映射 1），检索排序由"rerank 0.4 硬门槛替换制"改为 RRF 分与归一化 rerank 分按 0.4/0.6 加权混合，低 rerank 分结果被压后而非整条消失；空结果降阈值重查经核实不适用（FTS 已是 OR 宽松查询，无阈值可降）。新增测试覆盖越界归一、区间内原样、全同映射、混合排序压后不消失、rerank 全 0 回退 RRF、rerank 失败与未配置回退；`git diff --check` 通过，仅有既有 CRLF 提示。
- LocalHost Composition Root 第一批：Provider tests 4/4、LocalHost 定向 6/6、LocalHost 全量 34 文件 121/121、Provider 与 LocalHost typecheck、LocalHost 正式 build 全部通过；构建验证 87 个源码、349 个产物。新增测试覆盖源码/dist Catalog 快照定位、空快照降级、远端空目录保留已有索引，以及模型执行工厂构造期不发起网络请求；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- LocalHost Composition Root 启动策略计划：完整审计 `buildBindings()`、Lifecycle、BackgroundWork、Provider/Catalog、Character、Sandbox/Tool、Session/Settings、Memory、Attachment、Backup、MCP/Market/Skill 与 KB 的构造和启动链；冻结 eager/lazy/background 与 fatal/degraded/feature-local 矩阵、三轮并行文件所有权和分批验收。该批只更新计划与接力板，未改生产代码、未运行代码测试；使用 `git diff --check` 检查文档补丁。
- LocalHost 一次性启动装配：LocalHost typecheck、正式 build 与全量 33 个测试文件 117/117 通过，构建验证 85 个源码、341 个产物；新增测试覆盖 Marketplace/KB 前置顺序、重复 start 幂等、四项可降级初始化及统一后台关闭。`buildBindings()` 中 Skill/Catalog/Marketplace 启动副作用与进程入口 KB/Bridge 分散调用归零，`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- LocalHost 后台生命周期拆分：LocalHost typecheck、正式 build 与全量 32 个测试文件 115/115 通过，构建验证 84 个源码、337 个产物；新增测试覆盖启动/关闭幂等、恢复先于 Worker、后台 tick 单飞、Bridge 首次不可达与恢复事件。旧 `startBackgroundWork`、wiring 后台文件和 `AppBindings` 后台清理器字段引用归零，`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- LocalHost HTTP 传输边界第一刀：LocalHost typecheck、正式 build 与全量 31 个测试文件 112/112 通过，构建验证 83 个源码、333 个产物；新增 Server 测试覆盖无业务对象图挂载、统一认证和 404。`server.ts` 与根包公开入口的 `AppBindings` 引用归零，装配完成后无消费者的 `profileDb/credentials` 已退出绑定表。
- 剩余五组 AppBindings Route 收窄：LocalHost typecheck、正式 build 与全量 30 个测试文件 110/110 通过，构建验证 82 个源码、329 个产物；Cards、KB Embedding、Session Backup、Shell Permission 定向 4 个测试文件 15/15 通过。五组 Route 和相关测试中的 `AppBindings` 引用归零，`server.ts` 显式投影现有业务对象；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Settings 运行时接线第二批：Attachment、Vision、TurnExecution、LocalHost typecheck 通过；Attachment 14/14、Vision 19/19、TurnExecution 23/23、LocalHost 110/110 通过，4 个真实模型 Integration 按规则跳过。新增测试覆盖附件超限明确拒绝、根 Turn 设置深冻结和 Vision 下一次操作读取新快照；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Settings 运行时接线第一批：Settings、Context、TurnExecution、LocalHost typecheck 通过；Context 27/27、TurnExecution 23/23、LocalHost Settings/Theme Route 10/10 通过，4 个真实模型 Integration 按规则跳过。新增测试覆盖通用设置读写与非法值拒绝、每根 Turn 只读取一次设置、冻结快照不受后续对象变化影响、Context 请求设置不污染共享 Compactor 默认值；`git diff --check` 通过，仅有既有 CRLF 提示。
- Settings/Theme 配置所有权：Settings、Theme、Agent、Context、Permission、Attachment、Vision、Knowledge、LocalHost 与 Desktop UI 的依赖构建 43/43 通过；Settings/LocalHost/Desktop 定向 5 个测试文件 18/18 通过。设置写入按 SQLite 成功后再替换快照并发布事件，持久化失败与 Theme 前端保存失败均保留旧值；`SettingsStore` 直接使用 Storage `SettingsRepo`，镜像持久化类型已清理。
- TTS Provider 声音句柄生命周期：旧 `voiceUri` 与 Settings `runtimeCache` 生产引用归零；OpenAI 兼容与 DashScope 在协议未返回可靠有效期时标记为临时句柄，按角色、Provider 配置和模型进入两分钟进程内缓存。TTS/LocalHost 定向构建 40/40 通过，TTS 6 个测试文件 25/25 通过。
- Provider/ModelBindings 控制面收窄：Provider、Storage build，TTS 69/69 与独立 typecheck，LocalHost 正式 build（79 个源码、317 个产物），Desktop UI typecheck 通过；Storage 26 个测试文件 120/120、LocalHost 26 个测试文件 89/89 通过。旧 Provider/ModelBindings Route 和专用凭据/能力配置 Route 已删除，生产引用归零；Profile v13 将模型绑定迁为显式 `embedding_dimension`，配置更新的 `keep` 不再解密后重写密钥，Provider 删除/能力关闭仍经过绑定冲突检查和运行时刷新。
- Session Route 窄依赖：Session 全量 4 个测试文件 41/41、LocalHost 全量 26 个测试文件 89/89 通过；Session typecheck/build、LocalHost typecheck 与正式 build 通过，构建验证 72 个源码与 289 个产物。原 Session Route 已按集合、历史、附件、动作和标题拆分；Route 与测试中的 `AppBindings` 引用和强转归零，新增测试覆盖工作区运行时失效、永久删除清理顺序、标题模型失败回退及附件/历史 HTTP 契约。
- Permission Route 窄依赖：Permission Route 定向 5/5、LocalHost 全量 26 个测试文件 89/89 通过；LocalHost typecheck 与正式 build 通过，构建验证 65 个源码与 261 个产物。`permissionRoute()` 与测试对 `AppBindings` 的引用和强转归零，生产入口直接传入规则 CRUD 与 Permission 交互队列的窄投影；新增测试覆盖统一队列混合快照不会把 AskUser 条目暴露到 Permission API。
- Turn Route 目录内聚与交互取消隔离：Turn 21/21、LocalHost 26 个测试文件 88/88 通过；Turn/Tools build、LocalHost typecheck 与正式 build 通过，构建验证 65 个源码与 261 个产物。原 `routes/turns.ts` 已拆为启动、SSE、音频、工具审计、取消、AskUser 与 Schema 文件，生产和附件边界测试改用 `routes/turns/index.ts`；Turn 子路由对 `AppBindings`、`createTurnExecution/createTurnOutput` 的引用归零，完整装配进入 `wiring/createTurnsRouter.ts`。`cancelPermission/cancelAskUser` 的类型互斥与两个 HTTP 专属取消入口已有直接回归测试，`git diff --check` 通过，仅有既有 CRLF 提示。
- AppBindings Task/AgentRun 第一子批：Agent 7 个测试文件 28/28、LocalHost 25 个测试文件 85/85 通过；Agent build、LocalHost 正式 build 通过，LocalHost 构建验证 57 个源码与 229 个产物；全仓 typecheck 82/82 通过。`tasksRoute/agentRunsRoute` 对 `AppBindings` 与 `content_json` 的引用归零，测试不再通过 `as unknown as AppBindings` 构造伪完整对象。
- Route 业务副作用归位：Agent 7 个测试文件 27/27、TurnExecution 7 个非集成测试文件 22/22 通过，4 个真实模型 Integration 按规则跳过；LocalHost 25 个测试文件 85/85 通过。Agent、TurnExecution 按依赖顺序 build 通过，LocalHost 正式构建验证 57 个源码与 229 个产物；全仓 typecheck 82/82 通过。测试覆盖没有父 SSE 消费者时 AgentRun transcript 仍落库、投影写失败 warning 与后续重试，以及输入准备失败后统一清理该 Turn 的交互队列；旧 Route 投影与 Route 终态交互清理扫描归零，`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Turn 根取消与旧 Orchestrator 删除：TurnExecution 7 个测试文件 22/22 通过，4 个真实模型 Integration 按规则跳过；LocalHost 26 个测试文件 86/86、独立 typecheck 与正式 build 通过；全仓 typecheck 82/82 通过。追加清理后 Agent 25/25、Context 26/26、BuiltinTools 106/106（另 1 条依赖本机 `rg` 的用例跳过）、Hooks 27/27 通过，四包 typecheck 通过。测试覆盖陈旧 TurnId 不会误杀同 Session 当前活动 Turn、正确取消与终态后幂等；旧 `Orchestrator/activeTurns/OrchestratorTurn*` 扫描归零，`EmaStreamEvent` 只剩 `src/events` 的弃用兼容声明。
- TTS Turn 输出边界：TTS 7 个测试文件 67/67、LocalHost 26 个测试文件 86/86、Desktop UI 28 个测试文件 118/118 通过；TTS build、LocalHost 与 Desktop UI typecheck、全仓 typecheck 82/82 通过。测试覆盖关闭透传、即时音频不丢唤醒、根终态最后发送、失败取消、初始化/投影告警和 Voice URI 缓存隔离。应用生产代码与测试对弃用 `EmaStreamEvent` 的 import 已归零；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Turn Composition Root L5：新增唯一 `createTurnExecution.ts`，Orchestrator 对五层执行构造器的生产引用归零；反向扫描确认 `TurnInputPreparer/TurnContextBuilder/TurnToolsBuilder/RootAgentExecution/TurnExecutor` 的构造只剩 wiring 一处。LocalHost 26 个测试文件 86/86 通过；LocalHost typecheck 与全仓 typecheck 82/82 通过；`git diff --check` 通过，仅有既有 CRLF 提示。
- Root Agent Execution L4：新增 `RootAgentExecution + IterationTranscript`，根 AgentLoop、LLM/Message Hook、Emotion、非终态事件翻译与 transcript 已退出 `TurnExecutor`；反向扫描确认 Root Agent 不包含根终态提交或终态事件，TurnExecutor 不包含 AgentLoop、LLM Hook、Emotion 或消息写入。TurnExecution 7 个测试文件 21/21 通过，4 个 Live Integration 按规则跳过；LocalHost 26 个测试文件 86/86 通过；全仓 typecheck 82/82 通过；`git diff --check` 通过，仅有既有 CRLF 提示。
- Turn Tools L3：新增 `TurnToolsBuilder + TurnTools`，根 Turn 的 Capability Context、稳定 Tool Manifest/Policy、KB/Narrative/AskUser 窄入口、Subagent 与 ToolExecutionRuntime 生命周期退出 `TurnExecutor`；`TurnExecutionDeps` 只保留 Session/Hook/LLM/Emotion。TurnExecution 7 个测试文件 21/21 通过，4 个 Live Integration 按规则跳过；Agent 6 个测试文件 25/25 通过；LocalHost typecheck 通过；全仓 typecheck 82/82 通过；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Turn Context L2：新增 `TurnContextBuilder + TurnContext`，旧 `prepareContextContributions/compactContext/TurnContextCompactor` 生产引用归零；Memory Recall 证据进入 Turn 事件联合。TurnExecution 7 个测试文件 21/21 通过，4 个 Live Integration 按规则跳过；LocalHost 26 个测试文件 86/86 通过；全仓 typecheck 82/82 通过；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Turn 输入准备 L1：`TurnInputPreparer` 已接入 LocalHost，旧 `TurnExecutionPlan/PreparedTurnExecution`、LocalHost 私有媒体兼容与持久消息构造实现归零；附件 Store 公共类型去除无意义 `I` 前缀。TurnExecution 6 个测试文件 19/19 通过，4 个 Live Integration 因未配置真实模型密钥按规则跳过；LocalHost 26 个测试文件 86/86 通过；全仓 typecheck 82/82 通过；`git diff --check` 通过，仅有既有 CRLF 与不可访问测试缓存提示。
- Turn/TurnExecution/LocalHost 边界审计：完整复核 `turnExecutor.ts`、`agentLoop.ts`、LocalHost Orchestrator、Turns Route、wiring 与相关领域入口；确认 `TurnHandle.events` 可作为 SSE、未来 WebSocket 与 CLI 的传输无关事件源，LocalHost 是本机单 Profile 进程宿主而非远程万能后端。该批仅修改 `EmaRefactor.md` 与 `EmaWorkState.md`，未运行代码测试；使用 `git diff --check` 检查文档补丁。
- LocalHost L0：`pnpm install --offline` 确认 44 个 Workspace 项目；全仓 typecheck 82/82 通过，范围内显示 43 个包且新身份为 `@ema-agent/local-host`；LocalHost 28 个测试文件 93/93、独立 typecheck、build manifest 与产物导入通过；Desktop TypeScript typecheck、发布版本校验通过；Tauri runtime 资源名/readiness 3/3 通过；发布脚本 `node --check`、Rust `cargo fmt --check` 与 `git diff --check` 通过。旧硬身份在生产源码、构建和发布配置中的残留为零，只在迁移说明中作为禁止恢复的旧名称出现；`apps/core` 目录不存在，原 91 个受版本控制文件均能映射到 `apps/localHost`。
- Artifact 物理删除：全仓 typecheck 82/82 通过；Storage 120/120、BuiltinTools 96/96（11 skipped）、Backup 11/11、Core 93/93、Desktop UI 118/118、TurnExecution 11/11（4 skipped）、Agent 25/25、Tools 28/28、Session 37/37 通过。`@ema-agent/artifact` 依赖、`src/artifact` 目录、`artifacts` 表、ArtifactStore/ArtifactRepo/ArtifactEvent/IArtifactStore/ArtifactWrite/Read/List、`ReleaseFeaturesWire`/`artifactsEnabled` Feature Gate、capabilities 空壳端点、Desktop UI Artifact 面板/Store/API/测试、备份导出/恢复 Artifact 分支均已删除。Data v21 `DROP TABLE IF EXISTS artifacts` 兼容现有开发 DB；启动恢复定点清理旧 Artifact 目录，旧 Artifact ZIP 返回 `unsupported_content`。`git diff --check` 仅有既有 CRLF 提示。
- 附件/PDF 第一批：Storage、Session、Attachment、Knowledge、Tools build 通过，BuiltinTools 与 Core typecheck 通过；Storage 缓存迁移/Repo 2/2、Attachment 规范化/LRU/磁盘复用/空闲清理 3/3、Knowledge PDF 19/19、Builtin 注册与 ToolPool 6/6、Core 图片兼容 6/6 通过。Data 迁移编号已与 Artifact 删除协调为 v21/v22。
- Narrative R4：Narrative 与 BuiltinTools 按依赖顺序 build 通过；全仓 typecheck 84/84 通过；BuiltinTools 109/109、TurnExecution 11/11 通过，另有 1 个缺少系统 `rg` 的条件测试和 4 个 Live Integration 按规则跳过；`git diff --check` 仅有既有 CRLF 提示。
- TurnExecutor 第三刀：全仓 typecheck 84/84 通过；TurnExecution 11/11、Narrative 6/6、Hooks 27/27、Agent 25/25、Core 93/93、Desktop UI 132/132 通过，4 个 Live Integration 按规则跳过。Workspace 已移除 `@ema-agent/conversation`，源码、依赖和磁盘缓存目录全部清零；Chat 只读 Tool Manifest、Narrative 多周目部分失败、领域事件、持久化 Block 与 reasoning signature 往返已有直接测试覆盖。
- TurnExecutor 第二刀：全仓 typecheck 86/86 通过；TurnExecution 10/10、Core 93/93、Conversation 7/7 通过，4 个 Live Integration 按规则跳过。Work 生产调用已无 `turnExecutor.execute()`，`session.startTurn()` 只剩 TurnExecutor 与待迁 Chat 各一处；`TurnHandle` 准备失败、准备期取消、单消费者、终态 Promise 和运行锁释放已有测试覆盖。
- TurnExecutor 第一刀：全仓 typecheck 86/86 通过；TurnExecution 8/8、Agent 25/25、Turn 20/20、Conversation 7/7、Core 93/93 通过，4 个 Live Integration 按规则跳过。全仓检查顺带发现并修复桌宠 Permission Toast 未随 API 新契约提交 `turnId` 的既存类型错误。旧 `AgentEngine/AgentDeps/TurnExecutionInput/AskUserRegistryLike/AgentRuntimeEvent` 生产引用归零；`git diff --check` 通过，仅有既有 CRLF 提示。
- Skill Runtime：Skills 26/26、Context 26/26、BuiltinTools 106/106、Agent 33/33 通过，另有 1 个系统能力条件测试和 4 个 Agent Live Integration 按规则跳过；Skills、Context、BuiltinTools 按依赖顺序 build 通过，Agent、Core、Desktop UI typecheck 通过。测试覆盖 SKILL.md/脚本/Reference 的独立 path、Bundle revision、per-Agent fork 隔离、SkillCall 激活登记，以及只有 Macro 后才恢复 Skill Context。
- Skill/Subagent 内置工具收口：BuiltinTools 与 Agent typecheck 通过；BuiltinTools 104/104、Agent 33/33 通过，另有 1 个缺少系统 `rg` 的条件测试和 4 个 Agent Live Integration 按规则跳过。测试覆盖普通 Subagent 默认 fresh、后台控制统一使用 AgentRunId、模型可调用取消，以及父 Turn 收口时后台 AgentRun 取消终态；`git diff --check` 通过，仅有既有 CRLF 提示。
- Builtin Tool 搜索与公网访问收口：`public-http` 33/33、BuiltinTools 102/102 通过，另有 1 项“系统缺少 rg”条件测试因当前机器已安装 rg 而按预期跳过；两包 typecheck 及 `public-http` build 通过。真实 `rg` 语义覆盖相对路径、最大列宽、分页、跨行、类型过滤、上下文与全局 mtime 排序；WebSearch 已统一进入带 DNS 审批和 IP 固定的 `public-http`，额外敏感头禁止随重定向转发，既存裸域与 `www` 安全重定向口径已收口。
- Permission V1 最终收口：Permission、Turn、Tools、Agent、Core、Desktop UI typecheck 通过；Permission 18/18、Turn 20/20、Tools Prepared Call 5/5、Agent ToolExecutionRuntime 12/12、Core Permission Route/事件 4/4、Desktop Permission 恢复与提交 5/5 通过。测试覆盖永久规则 CRUD、工作区绝对路径校验、`turnId + promptId` 陈旧响应拒绝，以及 MCP 伪造 `not_required` 的构建期与运行时双重防线；`git diff --check` 通过，仅有既有 CRLF 提示。
- Permission/AskUser 统一交互收口：Turn 队列已泛型化，生产源码与 package 声明不再形成 `permission → storage → turn → permission` 依赖环；Permission、Tools、Turn、Agent build 通过，BuiltinTools 与 Core typecheck 通过；Tools 27/27、Turn 19/19、Agent 32/32、Core 90/90、Builtin Ask ToolPool 3/3 通过。此前 BuiltinTools 全量 72/73，唯一失败仍是既存 WebFetchPolicy 对 `example.com -> www.example.com` 的跨站重定向口径，与本批无关；Tools 缺失的 `diff` 运行依赖已离线补齐。
- Tools 残余清理：Session 级文件快照及跨层接线已删除；Tools/Context/BuiltinTools/Agent build 与 Core typecheck 通过，Journal/Presentation/Compaction/File Tools 定向 26/26 通过。此前全量 Tools 27/27、Context 24/24、BuiltinTools 71/72；唯一失败仍是既存 WebFetchPolicy 的 `example.com -> www.example.com` 重定向口径，与本批无关。pnpm lockfile 已离线刷新。
- Tool Presentation 与 Bash 首批审查（2D）：Tools typecheck、build 与 27/27 测试通过；BuiltinTools typecheck 通过，Presentation/Bash 定向 41/41 通过；BuiltinTools 全量 71/72，唯一失败仍是既存 WebFetchPolicy 对 `example.com -> www.example.com` 重定向口径，与本批无关；Core 与 Desktop UI typecheck 通过。`git diff --check` 通过，仅有既有 CRLF 提示。
- Tool Manifest 缓存稳定性（2C）：Tools 27/27、Context 24/24、Agent 29/29 通过，4 个 Agent Live Integration 按规则跳过；全仓 typecheck 84/84 通过。测试覆盖 Builtin/MCP 分区、选择顺序无关、等价 MCP 重连 revision 稳定、模型可见集合/Schema 变更 revision 更新、旧执行快照失效、Skill 收窄保序及 Prefix Hash 对真实工具顺序敏感；`git diff --check` 通过，仅有既有 CRLF 提示。
- Tool Context、真实 ToolPool 与 Port 所有权收口：Tools、Skills、Knowledge、BuiltinTools、Agent、Core 定向 typecheck 44/44 通过；Tools 26/26、Skills 24/24、Knowledge 42/42、Agent 29/29 通过，4 个 Agent Live Integration 按规则跳过；BuiltinTools 48/49，唯一失败仍是既存 WebFetchPolicy 对 `example.com -> www.example.com` 重定向口径，与本批无关。旧 Context、Bridge 注册标志、子 Agent 手写工具白名单及 Tools 内 Knowledge/Skill/Subagent Port 引用归零；`git diff --check` 通过，仅有既有 CRLF 提示。
- Tools 主执行链归位：全仓 typecheck 84/84 通过；Tools 26/26、Hooks 27/27、Agent 31/31 通过，4 个 Agent Live Integration 按规则跳过；BuiltinTools 本批相关测试与修改后的 Tool Call Integration 通过，全量仍只有既存 WebFetchPolicy 对 `example.com -> www.example.com` 重定向口径的 1 项失败。Tools 对 Agent/Session/Hooks、旧 `TurnToolExecutor/tool-executor` 与代码侧 `dispatch()` 引用扫描归零。
- Sandbox 依赖反转：全仓 typecheck 84/84 通过；Sandbox 5 个测试文件 19/19 通过；Bash 边界与注册测试 8/8 通过。BuiltinTools 全量测试中本批相关测试均通过，唯一失败仍是既存 `WebFetchPolicy` 对 `example.com -> www.example.com` 重定向口径不一致，与命令执行改动无关。
- 事件所有权第一批：业务事件已从 Turn 回到各自模块，`src/events` 只组合生命周期通道；TTS 警告不再伪装成 System 事件。离线刷新 Workspace 后全仓 typecheck 84/84；Agent 32/32、Context 23/23、Hooks 27/27、TTS 61/61、Core 92/92、Desktop UI 132/132 通过，4 个 Agent Live Integration 按既有规则跳过。
- AgentLoop 与 agentContext 收口：Tools build 通过，Tools/Agent/Core typecheck 通过；Agent 32/32 通过，4 个 Live Integration 按既有规则跳过；FileWriteTool 7/7 通过。Workspace lockfile 已离线刷新为 44 个项目，`@ema-agent/agent-context`、`turnLoop`、`loop_done`、`IFileStateStore*` 源码引用归零。
- Turn 执行/AgentLoop 与事件范围文档更正：`CLAUDE.md`、`EmaWorkState.md`、`EmaRefactor.md`、`EmaClaudeArchitectureReview.md` 已统一口径；事件目标统一为 `AgentLoopEvent/TurnEvent/AgentRunEvent/SessionEvent/AppEvent`。该批只改文档，未运行代码测试；`git diff --check` 唯一报错来自其他 Agent 的 `src/sandbox/shell-probe.ts` 既存尾随空格。
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

LocalHost L0、Turn 输入准备 L1、Turn Context L2、Turn Tools L3、Root Agent Execution L4、Turn Composition Root L5、TTS Turn 输出边界、精确根取消与旧 Orchestrator 删除、Route 业务副作用归位、全部 Route 窄依赖、HTTP Server 的 Route 注册表边界、后台生命周期对象以及一次性启动装配已经完成。Agent/Context/Attachment 用户设置已经冻结进每根 `TurnInput`，Vision 设置在每次 Operation 开始时读取一次；不要在 AgentLoop 中重读 SQL 或修改共享 Compactor。不要恢复 `apps/core`、`TurnExecutionPlan`、`PreparedTurnExecution`、万能 `TurnExecutionDeps`、LocalHost `activeTurns`、旧 Orchestrator、Route transcript/交互/音频投影回调、Route 直接解析 AgentRun `content_json`、Session Route 标题/删除副作用、Provider Route 业务编排、通用 `cancelActive`、TOML 设置存储、弃用 `EmaStreamEvent` 消费者、根包公开 `AppBindings`、旧 `startBackgroundWork`、绑定表中的后台清理器或 `buildBindings()` 中的异步启动副作用。先阅读 `EmaRefactor.md` §7.1.1 与 §7.1.2；下一批开始拆纯 `buildBindings()` 对象图，优先选择能返回真实领域入口的内聚构造段，不复制 `AgentBindings/ProviderBindings` 等嵌套依赖袋。Character Seed 是 Emotion 构造前置，迁移时必须保持 Live2D 外键、活动角色和 Emotion 初始化顺序。修改前先说明构造输入、唯一消费者和预期减少的宽字段，不要提交 Git。
```

## 维护方式

每完成一批，只更新当前阶段、工作区归属、最近验证、下一步和阻塞项。讨论过程与长篇原理写入对应 RFC/评审文档，不复制到本接力板。
