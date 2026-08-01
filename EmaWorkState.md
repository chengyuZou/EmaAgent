# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-08-01
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。统一执行主线第三刀已经完成：Chat/Work 都通过 `TurnExecutor.start() + AgentLoop` 执行，`TurnExecutor` 同步创建根 Turn 并返回单消费者、有界反压的 `TurnHandle`；执行 Profile 只控制迭代预算与模型可见 Tool Manifest，不再选择另一套 Engine。低层 `@ema-agent/turn` 继续只拥有根领域契约，不建立泛化的 Orchestrator、Runtime 或第三套 Engine。

LocalHost L0 纯改名已经完成：`apps/core`、`@ema-agent/core`、`ema-core` 及发布资源身份统一为 `apps/localHost`、`@ema-agent/local-host`、`ema-local-host`；Tauri RuntimeService、readiness、externalBin、发布脚本、CI 与文档已经同步。其后的 L1-L5、Route、HTTP、后台生命周期与 Composition Root P1-P5 也已完成，不能再把 L1 写成下一批。

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

事件通道同步完成消费者迁移：Turn SSE 使用 `TurnStreamEvent`，系统 SSE 使用 `AppEvent`，只有跨端通用解码器使用 `ClientEvent`；迁移期 `EmaStreamEvent` 兼容名已经物理删除。Task 更新明确属于 Turn 输出联合，Memory 进程级依赖只允许发送 `MemoryBackgroundEvent`，召回证据继续进入当前 Turn。

Settings/Theme 配置所有权与 HTTP 边界已经完成：用户设置继续使用 `profile.db.settings` 作为唯一持久化源，Storage 只提供纯 KV Repo；`src/settings` 直接消费 `SettingsRepo`，统一定义、Catalog、内存快照、提交顺序与变更事件，没有复制镜像持久化接口。Agent、Context、Permission、Attachment、Vision、Knowledge 与 Theme 已各自拥有显式设置定义，由 LocalHost Composition Root 聚合；既有 Event Display、Permission Timeout、Theme 与 KB Model URL 保持原 HTTP URL，并返回后端规范化后的持久值。Desktop Theme 支持先预览、保存失败回滚。TTS 上传句柄等供应商运行时缓存不属于用户设置，已退出 `profile.db.settings`。下一批按业务逐项接入仍未消费的新参数，不能把“已注册定义”误写成“运行时已经生效”。

Settings 运行时接线第一批已经完成：Catalog 新增稳定键查找，LocalHost 提供通用 `/api/settings/values/:key` 读写入口，所有写入继续经过业务定义的 decode 与 SQLite 后快照提交顺序。`agent.limits` 与 `context.compaction` 在 `TurnInputPreparer` 中只读取一次并冻结为根 Turn 设置快照；Agent 迭代、Tool/Subagent 预算和每次 Context 压缩都读取该快照，运行中的 Turn 不受后续设置更新影响，全局 `ContextCompactor` 也不保存并发 Session 的可变用户值。

Settings 运行时接线第二批已经完成：`attachments.limits` 在附件写入、图片数量/体积校验和 Vision 降级前随根 Turn 冻结，同一 Turn 不会混用新旧值；超限输入改为明确失败，不再静默截掉附件。图片规范化使用该快照的字节和长边上限，派生缓存配额在每次空闲清理开始时读取一次。`vision.limits` 则按 `nextOperation` 语义在每次 extract/probe 开始时取得一份已校验快照，排队及执行中的请求不会被后续设置变更改写。

L5 后余下 Route 收口已经完成：Transcribe 只接收 STT 执行面与模型绑定查询，Cards 只接收角色卡 Store，Shell 只接收 Permission 审批入口；Knowledge Base 与 Storage Stats 使用按业务命名的明确依赖集合。五组 Route 和对应测试不再导入或伪造 `AppBindings`，完整对象图只在 `server.ts` 与 `wiring/create*Router.ts` 等 Composition Root 展开，URL、状态码和响应协议保持不变。

LocalHost HTTP 传输边界第一刀已经完成：`server.ts` 只接收有序 `MountedHttpRoute[]`，统一处理 CORS、认证、请求预算、挂载、404 与异常协议，不再导入任何业务 Route 或 `AppBindings`。`wiring/createHttpRoutes.ts` 是当前唯一 HTTP Router 注册表，各 Router 仍在 Composition Root 取得自己的窄依赖；所有 URL 与协议保持不变。字段审计删除了装配完成后无消费者的 `profileDb/credentials` 运行期成员，根包也停止公开宽 `AppBindings/wire/createTurnExecution/createTurnOutput` 装配 API。

LocalHost 后台生命周期已经完成收口：`StartupRecovery.runRequired()` 在 ready 前恢复 ToolExecution、Turn 与 AgentRun，任一数据库恢复失败都会阻止启动；Memory 恢复、孤儿文件和遗留目录清理经 `runMaintenance()` 后台降级，Memory 恢复或初始化失败时不会继续 `tick/drain`。`BackgroundWork` 统一管理周期维护、Tool Result 与 Attachment Cache 清理、Bridge 心跳和有序关闭；MCP 只同步注册缓存 Schema，缺失 Schema 后台发现，Transport 保持首次真实调用时惰性连接。

Session 物理目录恢复已经补齐：永久删除继续先提交数据库级联，再 best-effort 删除 `{dataDir}/sessions/{sessionId}`；若进程在两步之间退出，启动维护会以数据库为事实源删除整棵孤儿 Session 目录，再扫描存活 Session 内的孤儿 Turn 文件。符号链接与 Junction 不会被跟随，单个目录被 Windows 句柄占用只记录失败并继续清理其余目录。

Memory 闲置后台维护 M1-M5 已完成：Session 活动根 Turn 注册表向 LocalHost 发布全局负载变化；轻量 Decay 与少量残留 Consolidation 在全局空闲 60 秒后运行，Storage Budget / Embedding Repair 必须连续空闲 30 分钟。新 Turn 或 LocalHost 关闭会在批次边界取消维护，预期抢占不记失败、不发伪完成事件。Profile v16 用 `last_decayed_at` 固化每行衰减周期，Decay 候选读取与 CAS 更新按 200 行小事务提交；Recall 引用加权、用户手动删除、Extraction、Decay、Consolidation、Embedding Repair 与 Storage Budget 共用 `MemoryCommitCoordinator`，模型和候选计算仍可跨 Session 并行。Consolidation 已按单节点快照、Node CAS 和 Profile 事务精确消费本轮 lazy update，模型往返期间的新证据不会被误删，ANN 增量失败会从 SQLite 事实源重建。Session 永久删除会先阻止新 Turn、撤销对应 Extraction 租约并取消事务外模型调用，再删除 Data DB 行；Profile 清理通过提交协调器等待已经开始的短提交，不等待可能忽略取消的 Provider。已经形成的全局长期记忆正文继续保留，崩溃留下的跨库孤儿由启动恢复补清。LocalHost 现提供进程内只读健康快照：各维护动作独立累计连续失败，初始化不可用或预算处理后仍超限立即退化，普通错误连续三次才退化，预期抢占和空扫描不产生警告。

LocalHost 一次性启动装配已经完成收口：`bootstrap/startLocalHost.ts` 在 ready 前先完成必需执行状态恢复，再尝试可降级的 Marketplace Seed 与默认 KB；Skill 对账、models.dev Catalog 与首次 Bridge 配置由 Lifecycle 跟踪为后台任务，关闭时等待仍在途的任务。启动不再 `kb.initAll()` 打开所有 KB；默认项失败只影响 Knowledge，具体 KB Client 继续在首次操作时惰性打开。角色卡 Seed 仍是 Character/Emotion 对象图的同步构造前置：EmotionEngine 立即需要活动角色，且角色卡写入受 Live2D 模型外键约束，不能伪装成可延迟后台任务。

LocalHost Composition Root 拆分计划已经冻结：轻量对象统一 eager 构造，真正的网络、文件、KB Client、MCP Transport 和 Skill 资源按 Operation 或资源 lazy；启动失败分为阻止 ready 的 `fatal`、禁用单项能力的 `degraded` 与仅影响单次调用的 `feature-local`。计划同时明确后台 Promise 必须由 Lifecycle 跟踪、核心 Turn/ToolExecution/AgentRun 恢复失败不得被清理 catch 吞掉、Memory 恢复失败时不得继续 Worker、默认 KB 目标改为可降级。施工计划位于本地忽略目录 `docs/architecture/localHostWiringRefactorPlan.md`。

LocalHost Composition Root 第一批已经完成：`createProviderControlPlane.ts` 统一构造 Provider 仓库、模型绑定、六模态模型池、models.dev Catalog 与能力解析器，并保证旧明文凭据迁移先于任何 Provider 配置读取；`createModelExecution.ts` 统一构造无 Session 状态的 LLM/Embed/Rerank/Vision/STT/TTS、Narrative、Usage、音频归档与 Provider 刷新入口。`bindings.ts` 立即解构两个工厂结果，`AppBindings` 继续保持现有平面协议，没有新增嵌套依赖袋。内置 Catalog 快照同时支持源码与 dist 资源路径，空/坏快照不会清掉已有目录或伪装成加载成功；后台刷新增加 10 秒取消信号。

LocalHost Composition Root Session/Memory 批次已经完成：`createSessionPersistence.ts` 统一构造 Session 聚合、统计与会话笔记入口，Memory、Session Dashboard 和 Backup 不再分别创建指向同一张表的 `SessionNotesRepo`；`createMemoryRuntime.ts` 只构造 Memory Planner 与两库 Repo，不启动索引或 Worker，`initialize/tick/drain` 继续由 `BackgroundWork` 管理。`ContextCompactor` 已退出 `AppBindings`，由唯一根 Turn 对象图 `createTurnExecution.ts` 构造并持有，不进入 Memory 工厂，也不按 Turn 重建。Route、恢复、后台和前端协议均未改变。

LocalHost Composition Root Attachment/Backup 批次已经完成：`createAttachmentRuntime.ts` 统一构造附件记录、共享派生缓存 Repo、图片派生缓存与空闲维护器，构造期不创建目录、不规范化图片也不启动清理；缓存配额仍在每次真实 sweep 开始时读取一次。`createSessionBackup.ts` 复用同一 Session、统计、会话笔记和 Attachment 入口建立 `SessionBackupFacade`，ZIP 校验、文件提交与事务恢复语义不变。`bindings.ts` 不再展开 Attachment/Backup 内部对象图，Route、后台时序和前端协议均未改变。

LocalHost Composition Root Extension/Knowledge/Lifecycle 批次已经完成：`createExtensionRuntime.ts` 统一构造 MCP、Marketplace 与 Skill，并使用 `profileDir()` 定位用户 Skill；`createKnowledgeRuntime.ts` 统一构造 KB、事件投影和模型工具搜索，`knowledgeModelsSetting/knowledgeRetrievalSetting` 继续在每次真实操作开始时读取。MCP 缺失 Schema 的并发发现按服务器名和工具名确定性提交，缓存写入晚于整批注册校验；KB 全量 `initAll()` 已删除。`bindings.ts` 保持扁平返回，没有新增嵌套依赖袋。

LocalHost Composition Root Character/Emotion 批次已经完成：`createCharacterRuntime.ts` 同步建立 Character Seed → 三类表现资源 Seed → Active Card → Emotion；缺少活动角色时仍激活 Ema，Emotion 初始词表来自构造时的当前全局角色。数据库、资源外键或活动角色不变量失败原样阻止 ready，运行期切换角色后的词表同步继续由既有 emitter 负责。至此本地施工计划 P1-P5 全部完成，`bindings.ts` 只表达 Character 工厂顺序并保持扁平返回。

开工前已复核本地 Codex 源码：`codex-protocol` 只定义 Thread/Turn/Submission 等低层协议，真正编排位于 `codex-core/session`；App Server 只校验并提交 `Op::UserInput`，Session 统一建立 `RunningTask`、取消句柄和终态，`RegularTask` 再调用内部 `run_turn` 完成多轮模型与工具循环。Ema 因此保留低层 `turn` 与高层 `turnExecution` 两个编译边界，不能把执行依赖反向塞进被 Context、Session、Storage、Hooks 共同依赖的领域包。

旧 `ConversationEngine` 与整个 `src/conversation` 包已经删除，Workspace 依赖和生产 import 归零。Chat 根生命周期与只读 Tool Profile 进入 `turnExecution`，LLM/Tool 迭代进入 `agent`，Narrative Route 与多周目 Recall 回到 `narrative`，模型可见召回正文通过不可信 Context Contribution 投递；Hook 不再携带 Narrative 私有结果。

Narrative R4 已经完成：`auto` 只在本轮 Tool Context 注入 NarrativeSearchPort，由模型按需调用稳定 ID 的 NarrativeSearchTool；`always` 继续在 Turn 开始时主动召回；`off` 不暴露工具也不召回。Port 在 TurnExecutor 绑定 Session/Turn、SSE 与 `narrative_context` 持久化，Tool 只接收窄查询能力；Route 与 LightRAG 继续使用 Narrative 自有 `lightrag-llm` 绑定，不读取当前 Chat/Work 模型。

事件所有权第一批已经落到源码：Agent、Characters、Context、Hooks、Knowledge、Memory、Narrative、System、Tasks、Tools 与 TTS 各自拥有 `events.ts`；Turn 只保留根生命周期、输出、Usage 与请求降级事件。`src/events` 像 `src/ids` 一样执行严格准入，但只负责组合 `TurnStreamEvent/SessionEvent/AppEvent`，禁止定义业务字段。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

Tool Prompt、内置 Skill、工作区指令与 Context Usage 的下一阶段边界已冻结在 `docs/toolPromptWorkspaceInstructionsAndContextUsage.md`：Builtin Tool 将在短 `description` 之外提供与真实实现一致的详细 `usagePrompt`；内置、用户和市场 Skill 统一提供稳定轻量 Catalog，只有可信内置 `always` Skill 与当前根 Turn 已激活 Skill 才投递全文，产品规则和 Tool 用法不得伪装成 Skill；工作区首批兼容 Codex `AGENTS*.md` 与 Claude `CLAUDE*.md/.claude/rules`，仅在两者缺失时使用 `.ema-agent/INSTRUCTIONS.md`；Context Usage 在每次 LLM Call 装配时计算并通过 Turn 事件推送，不采用前端轮询，也不把估算分类伪装成 Provider 精确 Usage。本轮只更新设计文档，尚未修改运行代码。

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

Desktop 窗口生命周期与透明主窗启动故障已经收口：聊天与设置在首次 `open_window` 时按原 label、URL 和尺寸惰性创建，后续关闭继续 hide-and-reuse；主窗由 `setup` 显式确保创建、显示与聚焦。透明窗口的直接原因不是 Live2D，而是 Desktop API 从 `@ema-agent/turn` 根出口引入浏览器不支持的 `SessionInteractionQueue -> node:crypto.randomUUID`，导致 React 挂载前终止；现由浏览器安全的 `@ema-agent/turn/protocol` 子路径只暴露 Turn Wire 协议。主窗 Dock 不再吞掉 Tauri Core/Event 加载和窗口命令失败，置顶状态只在原生命令成功后更新；取消置顶的无边框主窗失焦时自动最小化。表情入口只在真实 Live2D Runtime 活跃时可用，立绘或占位不会再提供无消费方的假按钮。普通浏览器预览仍会在调用 Tauri 窗口 API 前确认宿主注入存在。

BackgroundProcess 后端主链已经完成：Bash 在 15 秒内返回普通结果，超时则把同一进程一次性交给后台；显式后台、并发队列、持久状态/有界日志、ProcessList/ProcessOutput/ProcessStop、完成事件、内部续接 Turn、设置和只读/停止 API 均已接线。Session 删除会先终止所属进程并释放日志句柄。本批未修改 Desktop 前端。

Memory M1-M5 后端已经全部完成；本批没有修改 `apps/desktop-ui`。前端若接入健康展示，只消费 `/api/memory/health` 与退化边界事件。

当前基线最近提交：`d249726d feat: implement memory background health tracking and maintenance reporting`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

K3 当前负责 Desktop Chat Workspace、Git/Review 等前端工作；主 Agent 不修改其
`apps/desktop-ui` 施工区。后台进程前端已经补入 `EmaChatWorkspacePlan.md`，
现在可直接消费正式 API、领域事件与 Tool Presentation。

K3 当前负责 Desktop Chat Workspace 与 Git/Review 施工；本轮 Character 只修改 Desktop 的角色 API、角色设置 VoiceTab 和主窗资源选择，没有覆盖 Chat/Workspace 文件。

Character C1a/C1b/C2/C3a/C3b 已完成：Character 统一拥有显式多 Live2D、多立绘、参考音频、路径规范、Prompt 硬门、健康投影与稳定候选顺序。LocalHost 提供原子表现快照、主资源切换及三类资源单项导入/导出/更新/删除；Desktop `CharacterStage` 支持 Live2D → 立绘 → 占位逐级失败降级、同角色无空白切换、跨角色立即占位，以及迟到异步结果隔离。C3b 在 `.imports/.trash` 地基上补齐 Live2D 完整目录、立绘重编码和参考音频真实文件头深检，恢复清单 v2 区分 SQL 入口路径与物理目录单元。C3c 的 `card.json`、整包导入导出与 `importAsCopy/replace` 推迟到 V1 正式版候选，不建立半成品 Route 或 `.rollback` 语义；Desktop 目录选择必须签发目录能力句柄，不能回退明文绝对路径。Session Backup 继续不接 Character。

Session Backup ZIP V2 批一至批三已经完成：集中限制、十五类规范记录、严格流式 JSONL、显式 camelCase Wire DTO、逐条校验与流式 ZIP/完整性清单均已落地。Storage 现在通过 `SessionBackupReader.withSnapshot()` 在一个只读事务内按稳定顺序惰性流出十五类记录；Backup 在事务内逐行写本机临时 staging，事务结束后才冻结附件、音频和后台输出，缺失、不可读或复制期间变化的文件只形成不泄露本机路径的 manifest warning。慢 Sink 不再占用 SQLite 事务，调用方必须显式 `dispose()` 清理 staging。Facade/Route 仍只宣称 ZIP V1；V2 导入、启动清残留与公开接线尚未完成，Character 与整机备份继续不进入 Session Backup。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是一次有明确触发原因与唯一终态的有界 Agent 执行；V1 接用户消息触发，以及后台进程自然结束后严格受限的 `backgroundProcessCompleted` 触发。后者属于同一 Session 的系统来源，不冒充用户消息、不继承临时授权。TurnExecutor 管根生命周期、身份、持久化、取消与唯一终态，AgentLoop 管一个 Turn 内重复的 LLM/Tool/Result 迭代。
- 未来 Realtime/读屏/主动说话/直播属于长生命周期媒体或唤醒能力，不是新 Mode，也不能成为一个永不结束的 Turn；V1 暂不实现。
- Narrative 是保留多周目 Query Route 和专用前端 Block 的独立 RAG 能力，不是第三个 Engine。
- ContextAssembler 是模型窗口唯一组装入口；PromptAssembler 只产出显式、有序、可版本化的 PromptSlot。
- Provider 是控制面；LLM、Embed、Rerank、Vision、STT、TTS 是无 Session 状态的执行面。
- Tool 使用同一份不可变 PreparedToolCall 完成准备、审批和执行；Permission 与 Sandbox 物理分层。
- V1 完整实现持久 Task：TaskCreate/Get/List/Update、依赖、AgentRun 可选绑定、事务/CAS、事件、Context 提醒、恢复快照与独立前端 TaskList；Task Tools 只属于根 Turn，TodoWrite 完成迁移后删除。
- 后台 Shell 是 BackgroundProcess，使用 ProcessList/ProcessOutput/ProcessStop；不复用 TaskId、AgentRunId 或领域 Job 生命周期。15 秒内完成就返回普通命令结果，超过等待预算才把原进程转交后台；失败直接进入失败终态，不重新认领或自动重跑。状态元数据进入 active `data.db`，有界 stdout/stderr 进入 `{dataDir}/sessions/{sessionId}/background-processes/{backgroundProcessId}/`。
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
9. Turn/AskUser、Permission、Session、Provider/ModelBindings、Settings/Theme、Transcribe、Cards、Knowledge Base、Storage Stats 与 Shell Route 已完成窄依赖；HTTP Server、后台生命周期和一次性启动装配也已完成收口。`buildBindings()` 的 Provider/模型、Character/Emotion、Sandbox/Tool、Session/Memory、Attachment/Backup、Extension/Knowledge 对象图均已提取，LocalHost Composition Root 施工计划完成；后续不建立嵌套依赖袋或通用 `Lazy<T>`；
10. 后台进程 C 档后端已经完成：Data v25、Session 输出目录、状态机、显式后台、15 秒原进程转交、ProcessList/ProcessOutput/ProcessStop、按 Session 公平并发队列、领域事件与持久 Completion Inbox 已落地。长任务不保持 Turn 或 LLM 请求，也不让 Agent 轮询；自然完成、失败或超时后，在 Session 空闲时创建 `backgroundProcessCompleted` 系统 Turn，Session 正忙则等下一次安全 Context 边界。前端活动面板交给 K3，按 `EmaChatWorkspacePlan.md` §7.1 消费真实 API；
11. 外围质量收口（依据为 2026-07-29 外围模块评审与 ragflow/claude-code 参照研究，管线对照见 `docs/reviews/ragflow-claude-pipelines.md`）：
    - **R1-R7 已完成**：KB 摄入可靠性、检索质量、模型集成安全，以及 Memory 使用层、提取信任、判断层与溯源链均已落地；实现与验证见“最近验证”，不要继续作为待办重复施工；
    - **R8-R9 Skills 已完成**：bundle 资产全量哈希、市场清单 sha256 与安装强校验已经落地；子 Agent 工具上限 = 父当前收窄集 ∩ 自身工具池，只能更窄不能更宽；
    - **R10 MCP 已完成**：stdio 崩溃 onclose 感知、status 转 failed、惰性重连，以及 live/cache 共用的 Schema 字节与工具数上限已经落地；
    - **R11-R13 Memory/KB 已完成**：stale embedding 修复、租约丢失关闸、embed 模型变更后的 stale/reembed 生命周期，以及 Memory 全局逻辑字节预算、分级降压与 ANN 同步治理均已收口；
    - **A 主链真 Bug 已完成**：ToolResultStore EEXIST 只复用完全一致的内容；Usage 状态模型已区分 `cancelled`；Anthropic 已删除隐式 `maxTokens=4096` 并使用调用级剩余输出预算；
    - **B 主链安全收口**：install-git 与 mcpStdioGate 路由级审批已经接通；`AGEN_UNSAFE_*` 在正式构建中会直接阻止启动，不能由安装环境变量关闭隔离。Sandbox 状态接前端常驻提示仍属于前端工作；
    - **C 主链卫生已完成**：已删除 Macro 压缩后绕过 Memory 开关直接重读 L1 Session Note 的旧恢复旁路；正常 L1 Recall 继续作为不可压缩 Contribution 保留，Active Skill 继续走 required restore。AgentLoopState 已删除不可达状态；`prefixHash` 已明确为本次请求截止最终缓存断点的身份，会随历史、当前 Turn 和工具轮次演进，不再伪装成跨 Turn 固定 Prompt Hash。
12. Character C1a/C1b/C2/C3a/C3b 已完成显式资源、Prompt/健康门槛、主窗口可抢占降级、文件事务地基及三类资源单项生命周期。Live2D 目录有界复制并校验入口/引用/纹理，立绘重编码去元数据，参考音频按真实文件头冻结时长和摘要；导入、导出、删除分别使用同盘暂存、目标旁暂存和 `.trash`，SQL 失败与崩溃残留按事实源恢复。三类资源均可更新 `label/position/enabled`，禁用主项后由后端稳定提升下一启用资源。C3c 整包能力推迟到 V1 正式版候选；K3 正在接 Desktop 目录能力句柄和资源管理 UI。现有 Session Backup 不扩张到 Character。
13. Session Backup ZIP V2 下一批进入导入侧：流式解压到暂存、校验 SHA-256 与十五类记录、执行状态冻结、受控文件重落，最后用单个 SQLite 事务发布。随后再接 Facade/Route、启动清残留并删除 ZIP V1。不能复用巨型 `SessionRestorePayload`，不能在 V2 完成前删除 ZIP V1，也不能把内部 Record/JSONL/归档器重新导出为公共包 API。

命名随业务批次清理：旧 `IFileStateStoreEntry/IFileStateStore` 及后续过渡接口已经删除，`IToolExecutionJournal` 已改为职责名；其余迁移期 `I*` 类型继续随业务边界处理，不单独进行全仓机械重命名。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

- Desktop 主窗交互收口：Desktop UI typecheck/build、Desktop typecheck、Tauri `cargo fmt --check` 与 `cargo check` 通过；聊天、设置、退出、拖动与表情命令失败会显示真实错误，置顶按钮不再先改图标后静默失败。立绘/占位状态下表情按钮明确禁用；主窗取消置顶后失焦自动最小化。`git diff --check` 通过，仅有既有 Windows CRLF 提示。
- Desktop 透明主窗修复：浏览器运行日志确认旧链路在 `sessionInteractionQueue.js` 读取 `node:crypto.randomUUID` 时中断，改为 `@ema-agent/turn/protocol` 后该异常消失，主入口实际渲染出角色舞台占位及聊天、设置、置顶、退出等控制按钮；普通浏览器仅剩预期的未认证 LocalHost SSE 重试。Turn build、Desktop UI 与 Desktop typecheck 通过。Desktop 正式 Vite build 已越过原先的 Node-only Turn 阻塞并完成 1722 模块转换，现被独立的 `wlipsync` 顶层 await 与既有 `chrome105/es2022/safari13` target 不兼容阻塞，留发布构建批处理。
- Desktop 窗口惰性创建与主窗兜底：`apps/desktop/src-tauri` 的 `cargo fmt --check`、`cargo check` 与 6/6 Rust 测试通过；实机窗口枚举确认旧进程只有托盘、没有任何顶层窗口，现由 `setup` 显式确保 `main` 创建并显示，`chat/settings` 保持原 capability label 并在首次操作时创建。`git diff --check` 通过，仅有既有 CRLF 提示。尚需下一次干净启动手动验证主窗可见、首次打开 Chat 后历史/SSE 完整、Settings 首次创建与重复隐藏/显示正常。
- Session Backup ZIP V2 批三：Storage 定向 2/2、Backup 全量 46/46 通过，Storage build、Storage/Backup typecheck 与 `git diff --check` 通过。测试覆盖不存在 Session、惰性 SQLite 游标不会阻塞事务提交、稳定记录顺序、必需空 JSONL、存在附件冻结及缺失附件 warning；测试曾真实抓到“构造快照时同时打开所有 iterator 导致连接 busy”，已改为首次遍历该表时才打开游标。
- Session Backup ZIP V2 流式归档内核：Backup 5 个测试文件 45/45、独立 typecheck 通过；新增覆盖分块二进制、manifest 参与 SHA-256、完整性清单不自引用、路径穿越/白名单拒绝、Sink 写失败 abort 且不 commit。该批没有修改 Facade、Route、Storage 或 V1 Capabilities，避免把未接数据库一致快照的半能力暴露给调用方。
- Session Backup ZIP V2 批一修订：Backup 4 个测试文件 42/42、独立 typecheck 通过；测试覆盖并行 UTF-8 断字节、严格末行终止、原始字节跨分块上限、十五类注册表、真实数据库枚举、Usage 单 Session 边界、AgentRun 父子 Turn 一致性、Task 重复边/环和五万节点长链。JSONL 小块输入不再反复重编码整段缓冲，`git diff --check` 通过，仅有既有 CRLF 提示。
- Character 资源可编辑字段：Storage、Characters、LocalHost 正式 build 通过，LocalHost 构建验证 105 个源码、421 个产物；Storage 129/129、Characters 36/36、LocalHost 166/166 通过。三个 PATCH Route 只允许非空 `label/position/enabled`，内置角色保持只读；禁用主项与重新启用唯一候选均由 SQL 事务恢复确定性主项，真实变更的 `updatedAt` 保证单调前进。`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Chat 域重构 A–E + Desktop 清理（K3）：Desktop UI typecheck + 33 文件 166/166、Desktop typecheck 通过，零行为变化。A：workspaceStore/workspaceTypes/test 从 `chat/workspace/` 迁 `stores/`（13 处 import）；B：SessionSidebar 796→156 + `chat/sidebar/` 6 块（纯函数层零 UI 依赖）；C：ChatInput 668→393 + `chat/input/` 3 块；D：ToolCallBlock 459→215 + `chat/toolBlocks/` 4 块（用户自拆，K3 补 export 接缝）；E：chat 根 17→4 文件归组 messages/panels（用户自搬，K3 修 3 处漏网路径）。Desktop 清理：GlowBorder 粉白呼吸光 token 化（新增 `--ema-pet-glow/-bright` + `ema-breathe` keyframes + `.ema-pet-glow-border`，经 tokens/keyframes/components.css）；SidecarBadge/SpeechBubble 尾巴硬编码换 token；PermissionToastLayer 自造 Btn 换 ui Button；CharacterStage 类名 `__`→`-` 与 characterStage.css 改名同步。Backup 批一对账完成、方案冻结（ZIP v1 十条问题全属实；批一七项 additive 修复；断电恢复只做 B 档启动清残留；整机备份推 V1 正式版），等 Sol 指示开工。`git diff --check` 通过，仅有既有 CRLF 提示。
- Character C3b 单项资源生命周期：Characters 34/34、LocalHost 165/165 通过；Characters 与 LocalHost 正式 build 通过，LocalHost 构建验证 102 个源码、409 个产物。新增测试覆盖立绘规范化导入/导出/删除、Live2D 完整目录引用与纹理深检、参考音频真实 WAV 时长和摘要、LocalHost 文件能力句柄入口；测试同时发现并修正 WAV `byteRate` 字段偏移。`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Character C3a 文件事务批：Characters 2 文件 31/31、LocalHost 全量 43 文件 164/164 通过，Characters build 与 LocalHost typecheck 通过；测试覆盖参考音频 SQL 删除失败后从 `.trash` 原位恢复、发布路径冲突不误删旧文件、启动时恢复仍被数据库引用的中断删除、清理未入库的孤儿发布、领域入口拒绝删除活动角色，以及完整角色目录随非活动角色删除。`git diff --check` 通过，仅有既有 CRLF 与不可访问 Bridge 测试缓存提示。
- Character C2 主窗口降级批：Characters 2 文件 27/27、LocalHost 全量 43 文件 164/164、Desktop UI 全量 33 文件 166/166、Desktop 3 文件 12/12 通过；Characters、Events、LocalHost、Desktop UI、Desktop 五包 typecheck 通过。覆盖损坏主 Live2D 后继续同类候选、运行时切换主 Live2D、表现快照迟到请求隔离。Desktop Vite 构建已走到 1714 模块，最终被既有 `src/turn/interaction/sessionInteractionQueue.ts` 浏览器链导入 `node:crypto.randomUUID` 阻塞；与 Character 改动无关，后续需从 Desktop UI 依赖图移除 Node-only Turn 实现。

- Character C1b 资源自检批：Characters typecheck/build 与 2 文件 26/26 通过；LocalHost typecheck 与全量 43 文件 163/163 通过；`git diff --check` 通过。测试覆盖写入/激活/Prompt 装配三重空 Prompt 关闸、绝对路径/反斜杠/目录穿越拒绝、立绘实际格式/尺寸/字节深检、Live2D 缺失后立绘降级、同角色资源操作串行，以及 Cards Health/激活 HTTP 契约。K3 的 `apps/desktop-ui/src/chat/input/` 未跟踪施工区未触碰。

- MCP 拆分收尾（K3）：Desktop UI typecheck + 33 文件 166/166 通过。用户已拆出 KeyValueEditor/McpMarketView/McpServerRow 后，最后一块两个对话框归位 `McpServerDialogs.tsx`（295 行）：`McpImportDialog` 与 `McpServerFormDialog` 状态自包含（store 全局自取，表单/探测/导入结果内部管理），编辑实例经父级 `key={editing?.name ?? 'new'}` 重挂重置初值；`McpTab.tsx` 433→130 行纯装配。mcp/ 终态：McpTab 130 + MarketView 194 + ServerRow 186 + ServerDialogs 295 + KeyValueEditor 48 + ArgumentEditor 80 + form-state 82。`git diff --check` 通过，仅有既有 CRLF 提示。

- Character C1a 显式资源批：Storage 全量 29 文件 129/129、Characters 20/20、LocalHost 聚焦 2 文件 11/11 通过；Storage、Characters、LocalHost、Desktop UI、Desktop、Prompts 与 TurnExecution 定向 typecheck 通过。Profile v17 覆盖共享旧 Live2D ID、跨卡重复声音 ID、危险旧路径降级、旧列/旧表物理删除和外键检查；Seed 重复构造、资源聚合、主声音删除后确定性提升、旧 JSON API 拒绝、TTS/Live2D 路径新投影均已接线。

- MemoryTab 用户自拆验收 + Memory 后端全量对账 + stats 刷新补漏（K3）：Desktop UI typecheck + 33 文件 166/166 通过。用户按方法论自拆 MemoryTab 688→33 行主装配 + 7 块（Overview/Nodes/Items/MaintenanceTab/HealthCard/MaintenanceSettings/labels)，五关验收全过。Sol Memory 后端对账结论：routes/memory.ts 10 端点 memoryApi 全覆盖；`memory_tasks` 四 kind 仅 extraction 真实运行（maintenance/embedding_refresh/consolidation 为 schema 兼容残留，残留行明确标失败不重试），维护四操作走 backgroundWork + M5 健康投影，前端呈现各对各路无窟窿。补漏：`memory_consolidation_completed` 与 `memory_extraction_completed` 到达时刷新 memory stats（归并/提取后统计快照过期，与 maintenance_completed 同待遇）。`git diff --check` 通过，仅有既有 CRLF 提示。

- settings 大文件拆分（K3 负责 KB 与 Storage 两块）：Desktop UI typecheck + 33 文件 166/166 通过，零行为变化。**KnowledgeBaseTab 965→110 行**：拆出 `ChunkViewer`（分块游标分页）、`DocumentRow`（含状态标签映射）、`IngestForm`、`SearchTest`、`ProcessingQueue`（含 IngestJobRow）、`LibraryManager`（含 LibraryRow/CreateLibDialog）、`KbModelSettings`（含后台重建 SSE 收口）；主文件只留取数与拼块。**StorageTab 810→约 200 行**：拆出 `storageFormat.ts`（useMountedAnim + 五个 fmt 辅助）、`StorageDirDialogs`（添加/迁移对话框）、`DataDirRow`、`StorageStatsPanel`（含 EmptyRight）、`SessionDashboard`（SessionRow + 概览/音频/笔记三个子页 + ZIP 导出）。唯一刻意改名：SessionDashboard 内部的会话笔记子页 `MemoryTab` → `NotesTab`（与 settings/memory 的 MemoryTab 同名易混，未导出纯内部）。MemoryTab/McpTab 由用户按同一方法论自拆。`git diff --check` 通过，仅有既有 CRLF 提示。

- Session 孤儿目录启动恢复：LocalHost 定向 2 个测试文件 20/20、全量 43 个测试文件 173/173、typecheck 与 build 通过。测试覆盖数据库已删 Session 的整棵后台进程日志目录清理、存活 Session 保留，以及整目录清理先于孤儿 Turn 扫描。

- Memory M5 健康投影前端接线 + memory 设置 UI（K3）：Desktop UI typecheck + 33 文件 166/166、LocalHost typecheck + 173/173 通过。Sol M5 后端（MemoryBackgroundHealthTracker + GET /api/memory/health + memory_background_health_changed 仅退化边界发布）前端全接：`memoryApi.health`、`memory-store` health slice（refreshHealth 静默失败保旧值/onHealthChanged 原位替换）、dispatcher case、通知（进入退化警告带 lastFailure 公开文案、退出退化报恢复）、catalog 标签与后端默认值补登。MemoryTab：向量索引卡后新增 `MemoryHealthCard`（正常/维护中·操作/已退化 Badge + 最近失败含连续次数 + 存储压力用量/上限/仍超限标红）；`MemoryMaintenanceSettings` 落地 memory.maintenance（衰减起始天数/衰减幅度/冷删除天数）与 memory.storage（上限 MB 显示）——Sol Memory M1–M5 定型后最后两个无 UI key 清零，共用 shared/ 骨架即存。memory.models 模型选择器留待专项（参照 KbModelSettings 的 Provider 模型下拉）。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatHistory Codex 式工作区折叠（K3）：Desktop UI typecheck + 33 个测试文件 166/166（新增 workGroups 14 用例）通过。经 5 张 Codex 截图对齐形态：**纯模型** `chat/history/workGroups.ts`（groupSlices 连续工具分组、splitWorkAnswer 末尾 text 为正文其余进工作区、tallyTools 动词归类(Bash/Process*=命令,Edit/Write/ScratchpadWrite=编辑)/tallySummary 合并摘要(单条给具体文件或命令)、liveAction 流式当前动作(正在编辑/正在执行命令/正在运行/等待模型)、editedFiles 同文件归并汇总、formatTurnTime 当年 M月D日 HH:mm 跨年 YYYY年M月D日、formatWorkDuration 分档）。**组件**：`WorkSection`（"已处理 X · 摘要 · N 个错误红"折叠头，流式直播耗时与当前动作，终态默认收起）、`ToolWorkGroup`（组合并摘要行，失败计数红，展开为现有 ToolCallBlock）、`EditedFilesCard`（已编辑 N 个文件 +A -D + 每页 5 个"再显示" + 审核开 review 标签；无真实撤销能力不渲染）。AssistantBubble 重构：末尾 text 永驻为正文，其余全部进可折叠工作区；UserBubble 加绝对时间戳。用户拍板细节：动词合并一行、失败单条红+摘要带错误数、中止不红、流式摘要也用动词计数。`git diff --check` 通过，仅有既有 CRLF 提示。

- settings 文件夹按域归组（K3）：Desktop UI typecheck + build + 32 文件 152/152 通过，零行为变化。41 个平铺文件按 SettingsPanel 实际导航组归位：`general/`（通用设置组，含 Shortcuts/Appearance/Live2D 与本轮全部新组件）、`providers/`（AI 与模型组，含 BindingsTab——模型绑定属 Provider 控制面）、`character/`（CardsTab + CharacterCardEditor 及其内部子页 Identity/Behavior/Voice）、`skills/`（SkillsTab + MarketSourceManager，市场是技能内基座不单独立域）、`mcp/`、`memory/`、`knowledge/`、`data/`、`shared/`（SettingItem/NumberField/useObjectSetting 骨架）；`SettingsPanel.tsx` 留根。命名规则：文件夹名=左侧导航组。修正记录：McpTab 跨域引用 MarketSourceManager 改 `../skills/`;4 个测试文件（含本轮 settingAutosaver）旧路径同步；index.ts 导出面不变只改内部路径。`git diff --check` 通过，仅有既有 CRLF 提示。

- SSE 哑事件收口（K3）：Desktop UI typecheck + 32 文件 152/152、LocalHost typecheck + 166/166 通过。先全量对账（后端 ~100 事件字面量 vs 前端引用）：真正哑的 4 个——`tts_warning`、`memory_recall_unavailable`、`memory_extraction_skipped`、`memory_storage_budget_enforced`（Sol R13 新增，旧 review 清单之外）；`loop_*`×11 是 CLAUDE.md 明确的循环内部事件不过 SSE、`audio/file/image_*` 是内容块类型、`backgroundProcessCompleted/iteration/userMessage` 是 Turn 字段，均非哑事件。修复：`event-notifications` 补 4 条映射（tts 按 severity 分色、召回不可用含可重试标注、提取跳过直接用后端 reason 原文、预算执行区分是否仍高于低水位）；`system-event-dispatcher` 预算执行刷新 memory stats；catalog 补 4 个标签（memory_* 前缀自动进记忆组）；后端 `DEFAULT_EVENT_DISPLAY` 补登 8 项（4 哑事件 + tts_chunk/tts_sentence_complete/kb_embeddings_staled/background_process_changed）。改动只碰 localHost 设置与前端，未触 src/memory（Sol 在途）。`git diff --check` 通过，仅有既有 CRLF 提示。

- Settings UI 批 + Sandbox 状态（K3）：Desktop UI typecheck + 32 个测试文件 152/152（新增 autosaver 5 用例）通过。AstrBot Settings.vue 调研结论落地：骨架学其 settings-item 行（标题+大白话副标题+右侧控件）与高级项折叠，皮肤用自有 token。共用骨架：`SettingItem/SettingsCard/SettingsSection`（Provider 同款节头 + apply 时机标注）/`AdvancedSettings`（ema-collapsible 折叠专家项）/`NumberField`（本地文本态，失焦/回车按范围收敛）/`SaveStateIndicator`。即存机制：`SettingAutosaver` 纯 TS 状态机（700ms 防抖合并、tail 链串行不乱序、失败回滚最近成功值、dispose 静默）+ `useObjectSetting` 薄 Hook；vitest 为 node 环境无 testing-library，Hook 逻辑全在纯类里单测。5 个无 UI key 全部表单化：agent.limits、context.compaction、attachments.limits、vision.limits（MB/秒换算显示）进通用设置；kb.retrieval（命中数 + alpha/重排序权重滑块）进知识库设置。Sandbox 状态：`SandboxStatusSettings`（节头三态 shield + glass 状态卡四行 + 裸 Windows 黄字如实降级/unsafe-override 红字）进通用设置 PermissionRules 之后。memory.maintenance/memory.storage 因 Sol 在改 src/memory 本轮跳过。设置文件夹按域归组提案已给用户，拍板渐进归位不单独搬。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatWorkspace D2b Git 比较范围 + opener 拍板推迟（K3）：git-utils build + 13/13、LocalHost typecheck + 5/5 路由测试、Desktop UI typecheck + 31 个测试文件 147/147、Tauri `cargo check` 通过。gitUtils 新增 branches/commits 查询与 `refs.ts`（gitRefs 组装）、`diff.ts` 的 `gitCompareDiff`（commit=`git show --format=` 补丁；branch=merge-base HEAD 后 diff，比较分叉点含未提交；`collectTrackedDiff` 与 scope 链路共用，安全旗标与封顶一致）；路由 `GET /:id/git-refs`、`GET /:id/git-compare?type&ref`（参数校验 400，不存在的分支归 error capability 非 500）。ReviewPanel 范围选择器全量点亮：提交记录（有提交才出现，二级选择器选提交）与分支比较（有其他分支才出现，排除当前分支），范围失去来源回退上一轮，切范围默认选首个候选。**opener（"在…中打开"）2026-07-30 用户拍板推迟到 V1 正式版**：枚举到的本机 exe 不可信（同名伪造/注入/路径欺骗/启动死锁），内测无签名验证与防护不开放；初版固定名单+写死 LOCALAPPDATA 路径方案被用户否决（其 VS Code 在 D 盘即漏检），正确枚举方向（开始菜单 lnk/App Paths/.desktop + 词表筛选 + 真实入口启动）记入计划文档备重启；Rust openers 模块删除、`commands/mod.rs` 注释封存、cargo check 回到原状通过；分支切换/创建属 git 写操作，待专项评估。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatWorkspace 批次 F 后台进程面板（K3）：Tools build + 33/33、BuiltinTools typecheck + 96 通过 11 条件跳过、LocalHost typecheck + 全量 42 文件 163/163、Desktop UI typecheck + 31 个测试文件 147/147（新增 store 5 用例）通过。wire 增量 `BackgroundProcessSummary.outputDir`（`toSummary` 改 runtime 私有方法走 `locationFor` 同一工厂，不动 Sol 行为逻辑）。前端：`api/backgroundProcesses.ts` 三端点封装；`backgroundProcessStore`（每 Session 列表、64KB 渲染缓冲封顶、`background_process_changed` 事件原位更新不重拉、未加载 Session 不预取、Session 删除清理列表/输出/跟随循环，经 session-store.deleteSession 接线）；`backgroundProcesses` tab kind 注册（TabBar 图标/标签 + WorkspaceFrame 内容）。面板：进行中/已结束分组列表 → 详情（命令/cwd/exit/时长/输出量事实行、scrollToTurn 来源轮次、stdout/stderr 有界渲染、上游更多如实提示 + 「在文件管理器中显示」走 opener 插件 `reveal_item_in_dir`——capabilities/chat.json 补权限，仅 chat 窗口、live 跟随尾部长轮询、终止仅 queued/running 只提交 backgroundProcessId）。入口：置顶摘要后台进程行（● N 运行中 ○ M 已结束）；ToolCallBlock 新增 `background_process` presentation 卡片（块当场终结只给面板入口，不渲染 processReference JSON）。通知只对 failed/timedOut 弹 toast（完成静默，用户拍板），catalog 补登。用户拍板输出截断：前端 64KB 封顶不逐页加载全量日志。修正记录：`BackgroundProcessEvent` 未从 @ema-agent/events 再导出（只在联合里），store 改从 @ema-agent/tools 导入；详情回列表的 setState 从渲染期挪到 effect。LocalHost 首跑 exit 1 为构建中途瞬态（同前两次），复跑两次 163/163 exit 0。`git diff --check` 通过，仅有既有 CRLF 提示。

- E2 Terminal / E3 Browser 推迟拍板（K3，2026-07-30 用户决定：着急内测，两项推到 V1 正式版）：代码不删——`workspaceTypes.ts` 的 `terminal`/`browser` tab kind 保留并加推迟注释，启动器不提供入口；`WorkspaceFrame` 内容区防御渲染升级为明确说明"终端/浏览器功能暂未实现，将在 V1 正式版提供，内测版不开放"（图标 + 双行文案），不渲染假能力。Desktop UI typecheck 通过；计划文档批次 E 两项标注推迟及重启参照（codex `utils/pty`、PTY 归属决策、与 BackgroundProcess 划界）。

- ChatWorkspace E1 Review 工作区 diff（K3）：git-utils build + 13/13（patch 分段解析、真实临时仓库双 scope、untracked 伪 diff、干净仓库零 omitted）、LocalHost typecheck + 4/4 路由测试、Desktop UI typecheck + 30 个测试文件 142/142（新增 diffModel 5 用例）通过。`src/gitUtils/diff.ts` 按 codex `/diff` 同款：tracked `git diff [--cached]`（`-U20` 有界上下文供增量展开）+ untracked 逐文件 `--no-index` 伪 diff（`runGit` 新增 `allowedExitCodes` 与 `maxOutputBytes` 选项，exit 1 正常、单文件失败计 omitted）；安全旗标 `--no-textconv --no-ext-diff --submodule=short --ignore-submodules=dirty`，`filter.*.clean/process` driver 经 `git config --get-regexp` 查出置空（与 hooksPath=NUL 同威胁模型）；封顶：单文件 200K 字符截断、总量 2M、单 scope 200 文件、untracked 50，超出如实计 `omittedFiles`。路由 `GET /api/sessions/:id/git-diff` 与 git-summary 共用身份解析。前端 `review/diffModel.ts`（unified diff 解析/折叠段推导/分列配对，纯函数）+ `DiffCard.tsx` + ReviewPanel 重写：范围下拉（上一轮/全部会话恒在，未暂存/已暂存仅 capability=ok 出现，失去来源自动回退）、折叠优先增量展开（变更行恒显、长上下文折叠段每次展开 20 行、hunk 间隔如实标"N 行未变更"不可展开——无数据不假装可展）、跳转到文件（过滤输入 + 文件清单视图点击滚动定位）、`file:<path>` 标签打开、统一/分列切换不丢展开状态、自动换行、git scope 刷新。实施偏差记入计划文档：-U20 有界缓冲替代原案按需重算；"提交记录/分支比较"范围项待 D2b 数据源；"隐藏空白字符"待后端 -w 参数。测试样例行号期望先错两处（样例 hunk 头与行数不自洽），修正样例后全绿，非源码问题。`git diff --check` 通过，仅有既有 CRLF 提示。

- BackgroundProcess 后端主链：Storage 27 个测试文件 125/125、Tools 7 个测试文件 33/33、BuiltinTools 15 个测试文件 106/106（另 1 条依赖本机 `rg` 的条件用例跳过）、LocalHost 42 个测试文件 161/161 通过；Storage/Tools build、BuiltinTools/LocalHost typecheck 与 `git diff --check` 通过。测试覆盖 15 秒同进程转交、显式后台、日志截断与续读、Session 公平队列、停止/完成/失败终态、Session 删除先停进程并释放 Windows 文件句柄、跨 Session API 越权拒绝、内部完成 Turn 不伪造用户消息，以及不可信命令输出的边界转义。

- ChatWorkspace D2a Git 只读源（K3）：新模块 `src/gitUtils`（`@ema-agent/git-utils`）build + 8/8 测试（真实临时仓库：not-a-repo 裁决、子目录向上找根、干净仓库零统计、未暂存/已暂存/未跟踪分别计数、origin 远端地址）、LocalHost typecheck + 3/3 路由测试 + 全量 40 文件 155/155、Desktop UI typecheck + 29 个测试文件 137/137 通过。结构按 codex git-utils 拆细防 god 文件：`gitProcess`（execFile 无 shell、5s 超时即杀、4MB 上限、强制 `-c core.hooksPath=NUL`/`-c core.fsmonitor=false`、`GIT_OPTIONAL_LOCKS=0`/`GIT_TERMINAL_PROMPT=0`）、`repoDetection`（纯 fs 祖先 .git 走查）、`queries/`（branch/changeStats/status/upstream/remote 一文件一命令）、`summary`（capability 裁决后并行查询，GitError 归入明确 capability 不抛出）；`errors.ts` 集中 `GitError`。`GitSummary` 为 capability 判别联合（ok/not-a-repo/git-unavailable/error），ok 携带分支/detached SHA/未暂存/已暂存/未跟踪/upstream/originUrl，非 ok 不携带猜测字段。路由 `GET /api/sessions/:id/git-summary`：Session 拥有 workspaceRoot，无 root 显式 400。前端 `api/git.ts` + 置顶摘要环境信息区 Git 行仅 ok 渲染（分支或 detached @ SHA、变更计数 +ins/-del、未跟踪数，点击开 review 标签；有 origin 时追加"远端"行），其余 capability 整行隐藏不做降级文案。codex git 面全仓对照结论（UI 面=状态栏分支+/diff+/review 选择器，其余为云架构遥测与内部基建不拿）与批次 E 工作区 diff 安全旗标（--no-textconv/--no-ext-diff/filter driver 置空/untracked --no-index）已记入计划文档。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatWorkspace 批次 G 块形态对齐（K3）：Desktop UI typecheck 与 29 个测试文件 137/137 通过。**子代理块**按 §6 重写：已开启（空如实显示）/完成 · N 分组、行形态图标+标题+摘要+相对时间、截断"再显示 N 个"、点击进入标签内详情页（返回 + 标题/状态 Badge + 模型/轮次/工具/tokens/耗时事实行 + transcript），清空已完结保留，统计头与搜索按 Codex 形态移除。**附件块**归位 `sources/SourcesPanel.tsx`（旧 SessionAttachmentsPanel 删除）。**Review 上一轮过滤**：ReviewPanel 默认"上一轮"范围（`useLatestTurnDiffs`，与改动计数同语义），可切"全部会话"，空范围如实提示并一键切换。两个不伪造裁决已记入计划文档：AgentRun"已编辑文件卡/审核动作"因 `agent_run_messages` 无 file_change 载体跳过；附件"完整路径行"因 wire 无原始路径跳过。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatWorkspace 批次 C3 全宽展开与 ChatInput 浮动条（K3）：Desktop UI typecheck 与 29 个测试文件 137/137 通过（新增全宽 4 用例）。RightDock 三态（折叠/普通/全宽）：放大按钮只在 Dock 展开且有内容时渲染（TabBar 尾部），全宽时 Dock 宽 100% 且拖拽手柄隐藏，顶栏三入口收敛为"恢复面板宽度"单按钮；`fullWidthBySession` 是 store 顶部当次状态（不进持久层），有效性按"标记 + rightOpen + 有标签"派生（`isRightFullWidth`），折叠 Dock 即清标记、重开回普通宽度。ChatPanel 改槽位传参（header/history/activity/input/statusBar），ChatHistory 与 ChatInput 以标签池同款 portal 在两处位置间迁移；全宽时聊天列 hidden（不卸载），ChatInput 变底部居中浮动条（宽 min(720px,92%)），chevron 展开为 50vh 悬浮聊天卡（嵌入同一 ChatHistory 实例），开合是当次状态不写记忆。已知取舍：输入框迁移即重挂，附件队列等本地状态在全宽切换时重置（草稿经 store 保留）。`git diff --check` 通过，仅有既有 CRLF 提示。

- ChatWorkspace 批次 D1 ChatHeader 与置顶摘要（K3）：Desktop UI typecheck 与 29 个测试文件 133/133 通过。新增 `ChatHeader.tsx`（标题 + 置顶摘要/底部面板/右侧栏三个 IconButton，激活态走 `toggled`，摘要按钮带子智能体运行角标）与 `summary/PinnedSessionSummary.tsx`（环境信息只渲染真实的"本地 + workspaceRoot"行——Git 行待 D2 只读来源，不渲染假行；运行活动只渲染子智能体行（● N 运行中 ○ M 已完成，点击开 `agentRuns` 标签）——后台进程行待批次 F 后端，不画假运行项；来源为真实附件截断列表 + "查看全部"开 `sources` 标签）。ChatPanel 的 C2 过渡 ⋮ 菜单与 OverflowItem 删除，顶栏换装 ChatHeader。"在…中打开"按钮按"不存在的能力不显示入口"待 D2 Tauri 检测；全宽展开模式与 ChatInput 浮动条留待 C3。`git diff --check` 通过，仅有既有 CRLF 提示。
- ChatWorkspace 批次 C2 Workspace Dock 框架与迁入（K3）：Desktop UI typecheck 与 29 个测试文件 133/133 通过。新增 `WorkspaceFrame/WorkspaceDock/WorkspaceTabBar/WorkspaceLauncher`：RightDock/BottomDock 共用同一 Dock 组件（BottomDock 横跨聊天列与 RightDock、不盖 SessionSidebar），**标签池经 React Portal 挂在 Frame 层**——全部标签常驻、激活显示其余 hidden，跨 Dock 移动只换 portal 目标不重建组件实例（移动不丢内部状态），内容容器常驻使折叠也不卸载；空 Dock 显示居中启动器（只列审阅/文件/来源/子智能体四个真实能力），TabBar 支持激活/关闭/右⇄底移动（DropdownMenu）。迁入：FilesPanel 点击文件改开 `file:<path>` 标签（FilePreview 作为标签内容，同路径归一单实例）、SessionAttachmentsPanel 作为 sources 内容、AgentRunPanel 新增 `initialExpandedId` 支撑 `agentRun:<id>` 深链、ReviewPanel 接 `review` 标签。ChatPanel 旧 Inspector（Set/Grid/拖拽宽度/面板头）整体退役，⋮ 菜单改为开标签。资源键补充 `agentRuns` 列表面板（计划 §4.2 已追记）；terminal/browser 类型保留但启动器不提供入口，防御性渲染明确说明。样式零硬编码：新增 `.ema-transition-height` 与 `.ema-resize-handle-h/.ema-resizing-v` 均沉淀在 styles。`git diff --check` 通过，仅有既有 CRLF 提示。
- BackgroundProcess 设计冻结：完整对照 Claude Code 的 Bash 显式后台、
  Assistant 15 秒原进程转交、LocalShellTask、TaskOutput/TaskStop、统一输入
  队列与完成通知，并按 Ema 的 Task/AgentRun/Process 边界写入
  `EmaRefactor.md` §6.1。结果契约不使用 foreground mode，而是区分即时
  `commandResult` 与后台 `processReference`；V1 提供
  ProcessList/ProcessOutput/ProcessStop，失败不重试、不重新认领。持续数小时
  的进程由 Supervisor 管理，完成后通过持久 Completion Inbox 在同一 Session
  注入安全 Context 边界，或创建 `backgroundProcessCompleted` 系统 Turn，
  不冒充用户消息、不让 Agent 轮询。`EmaChatWorkspacePlan.md` 已补运行活动
  摘要、后台进程动态标签、API 与 K3 委派边界。本批只修改文档，未运行代码测试。
- ChatWorkspace 批次 C1 workspaceStore（K3）：Desktop UI typecheck 与 29 个测试文件 133/133 通过（新增 workspaceStore 14 用例）。`chat/workspace/` 纯状态机零 JSX：`workspaceTypes.ts` 可判别 `WorkspaceTab` 联合与每 Session 布局（宽度/高度按 §4.4 语义作为全局偏好留在 store 全局字段，不进每 Session 布局；file 资源键归一斜杠与 Windows 盘符防同路径双标签）；`workspaceStore.ts` 实现同资源单实例（已存在则激活、显式指定异 Dock 则移动同一实例）、关闭激活项邻居接管、关闭最后标签 Dock 自动折叠、显式关闭不进持久层、折叠保留标签原样恢复、每 Session 隔离；localStorage 持久化带损坏 JSON 回退、失效激活项与空 Dock open 标记的恢复纠正，Node 测试环境无 localStorage 时静默降级。`git diff --check` 通过，仅有既有 CRLF 提示。

- V1 后端最终闸门第一批：正式构建已拒绝三个 `AGEN_UNSAFE_*` 沙箱绕过开关；Telemetry 无生产消费者的 Repo、公开类型和测试已删除，Data v24 负责清理旧库表；附件图片改为同一文件句柄上的异步有界读取，读取期间增长也不会突破 5 MiB 内存上限；Character Card 两个未实现死入口与 `EmaStreamEvent` 兼容名已删除。Attachment 14/14、Storage 125/125、LocalHost Sandbox 10/10 通过；Attachment、TurnExecution、LocalHost 定向 typecheck 及全仓 typecheck 86/86 通过。首次 Storage 回归因旧测试仍断言 Data v23 失败，更新到 v24 后全绿；`git diff --check` 通过，仅有既有 CRLF 提示。
- Memory R13 存储预算收口：Profile v15 为 Node/Item 增加明确的 `embedding_evicted_at`，逻辑字节核算覆盖 Memory 主表；后台约每 30 分钟按“过期 Item → 长期未引用的零重要度非保护行 → 非保护冷向量”分级降压到 85% 低水位，`user_fact/preference/relationship` 与用户反馈类保持保护。主动驱逐的向量不会被 stale repair 立即重建，正文更新后才重新进入修复队列；SQLite 成功而 ANN 增量删除失败时触发索引重建。新增 `memory.models`、`memory.maintenance`、`memory.storage` 设置，默认上限 512 MiB，运行时按下一次操作读取。Storage 28 个测试文件 129/129、Memory 14 个测试文件 60/60、LocalHost 39 个测试文件 150/150、全仓 typecheck 86/86 通过；`git diff --check` 仅有既有 CRLF 提示。
- Memory 闲置后台维护 M1：Session 5 个测试文件 42/42、Memory 14 个测试文件 62/62、LocalHost 42 个测试文件 163/163 通过；三包 typecheck 通过，Session/Memory build 刷新声明成功。测试覆盖活动 Turn 阻止重维护、Turn 结束后重置空闲窗口、运行中被新 Turn 抢占、Embed 等待期间取消不落库，以及 Storage Budget 每 200 行让出并停止后续批次；`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。设计依据位于 `docs/architecture/memoryBackgroundMaintenancePlan.md`，下一批是 M2 全局维护写入协调与 Decay 安全让步；M3-M5 仍是目标设计，不能写成已完成。
- Memory 闲置后台维护 M2：Profile v16 增加 Node/Item `last_decayed_at` 与衰减候选索引；Decay 按 200 行执行候选快照 CAS，同一 `decayAfterDays` 周期不会因空闲扫描或快速重启重复扣减。Recall 引用加权与用户手动删除也接入全局提交协调器；新增跨 Session 计算并发/提交串行、取消后不发完成事件、周期与旧快照 CAS 测试。Storage 28 个测试文件 127/127、Memory 15 个测试文件 64/64、LocalHost 42 个测试文件 165/165 通过，全仓 typecheck 88/88 通过；Storage/Memory build 与 `git diff --check` 通过。重维护空闲阈值按产品口径改为 30 分钟，调度改为每个后台 Tick 检查空闲资格、成功开始后再进入 30 分钟冷却，避免固定扫描相位把真实等待拉长到近一小时；下一批是 M3 Consolidation 原子提交，不提前混入 M4/M5。
- Memory 闲置后台维护 M3：Consolidation 从 `extract` 后处理升格到 `memory/consolidation`，每个 Node 在模型与 Embed 前冻结正文、重要度、版本及 lazy update 主键集合，外部 I/O 不占全局提交协调器；提交时在同一个 Profile 事务内复核精确证据集合、执行 Node CAS 并只删除快照证据。并发到达的新证据保留，Node/证据冲突丢弃旧计算结果而不覆盖、不误删；无新向量时清除旧正文向量，ANN 增量失败时在同一提交序列内重建。Extraction 与全局空闲 60 秒后的少量残留扫尾复用 `MemoryPlanner.consolidatePendingNodes()`。Storage 28 个测试文件 127/127、Memory 16 个测试文件 69/69、LocalHost 42 个测试文件 166/166 通过；Storage/Memory/LocalHost 定向 typecheck 与 Storage/Memory build 通过。全仓 typecheck 的 Memory 与 LocalHost 链已通过，最终被 K3 在途 Desktop UI 设置组件的五处泛型约束错误阻断（85/87 个任务成功），本批没有修改该并行施工区。下一批是 M4 Session 删除与在途 Extraction 的取消、提交段退出和来源软引用清理，不提前混入 M5。
- Memory 闲置后台维护 M4：Session 删除协调先阻止新 Turn并取消当前根 Turn，再关闭该 Session 的 Extraction 入队、删除持久任务撤销租约并取消在途模型调用；删除请求不等待可能忽略取消的 Provider，迟到结果仍受既有提交前租约闸门约束。Data DB 删除完成后，Profile 清理通过全局提交协调器等待已经开始的短提交，再删除 Node 来源、脱敏 L2 Item/待归并证据来源并清理恢复标记；长期 Node、Item 与证据正文继续保留，启动恢复以 Data DB 为事实源补清跨库孤儿。Session 45/45、Memory 72/72、Storage 127/127、LocalHost 166/166 通过；Storage/Session/Memory build、四包定向 typecheck 与 `git diff --check` 通过，仅有既有 CRLF 提示。全仓 typecheck 的本批与下游链均通过，最终 85/87 被 K3 在途 Settings 目录迁移中 `McpTab.tsx` 尚未归位的 `MarketSourceManager.js` 阻断，主 Agent未触碰该前端施工区。M1-M4 至此完成，下一批若继续 Memory 是独立 M5 健康投影，不提前混入前端实现。
- Memory 闲置后台维护 M5：健康投影由 LocalHost 调度层拥有，Memory 只提供跨端契约和维护报告；`GET /api/memory/health` 返回当前进程的 idle/running/degraded、活动动作、最近完成、按动作连续失败和存储压力。初始化失败与未解除的存储压力立即退化，普通维护连续三次失败才退化，其他动作成功不会产生假恢复；只在进入或离开退化状态时发布应用事件，取消与正常空扫描零噪音。Memory 17 个测试文件 72/72、LocalHost 43 个测试文件 171/171、全仓 typecheck 88/88 通过；Memory/LocalHost build 与 `git diff --check` 通过。

- 前端 F2 样式回潮批（K3）：Desktop UI typecheck 与 28 个测试文件 119/119 通过。tokens.css 新增 `--ema-file-*` 八枚文件类型色（亮暗共用的常规文件色，不随主题翻转）与 `--ema-shadow-dragover`；AttachmentChip 8 处 oklch 字面量、ChatInput 拖放 boxShadow 与 border-white、AppearanceTab 白色选中环全部 token 化；FloatingDock 与 SessionSidebar 的 duration/ease 字面值改走 `--ema-duration-*`/`--ema-ease` 与 `transition-ema`；SessionSidebar 自造 max-height 折叠组件换为标准 `.ema-collapsible`（删掉三处 maxHeight 计算）；AgentRunPanel 自造分隔线换 UI 包 `Divider`；ChatPanel 400ms 字面时长归入 slow 档。`git diff --check` 通过，仅有既有 CRLF 提示。

- 前端 F1 API 接线批（K3，仅 api 层，按用户划定边界不碰 UI/Store/业务组件）：Desktop UI typecheck 与 28 个测试文件 119/119 通过。新增封装：`systemApi.getSandboxStatus`（/api/system/sandbox，本地镜像 SandboxStatusWire，desktop-ui 不依赖 sandbox 包）、`settingsApi.getCatalog/getValue/putValue`（/api/settings/catalog + /api/settings/values/:key 通用通道，本地镜像 Descriptor/ApplyPolicy）、`knowledgeBaseApi.getReembedTasks`（/api/kb/reembed-tasks，刷新后恢复路径与 ingest-tasks 对称）、`turnsApi.listToolExecutions`（/api/turns/:id/tool-executions，ToolExecutionRecord 复用 @ema-agent/tools 类型）。`/api/skills/:name/relocate` 经核实为后端刻意 fail-closed 501（V1 多 Root 未落地），不做封装。settings 5 个无 UI 的 key（agent.limits/context.compaction/attachments.limits/vision.limits/kb.retrieval）现在有了通用读写通道，UI 接入留给后续批次。`git diff --check` 通过，仅有既有 CRLF 提示。

- Memory 后台 R11 最终收口：Memory 13 个测试文件 56/56、Storage 27 个测试文件 126/126、LocalHost 39 个测试文件 150/150、全仓 typecheck 86/86 通过；Storage build 通过。租约探针现在覆盖 profile/data 主事务、未配置模型清空、恢复标记清理、L1 Note 压缩和 consolidation 真正写入点；租约易主不写终态也不发送虚假完成事件。stale embedding 修复按 32 行小批隔离 Provider 异常，严格校验实际空间、维度和字节数；Repo 使用 `updated_at + stale space` CAS，旧文本向量不能覆盖并发更新，过期 Item 也会在提交时复核。SQLite 成功而 ANN 增量同步失败时立即从源数据重建；新增测试覆盖 CAS 冲突、异空间拒绝、跨类型失败隔离、索引恢复，以及此前遗漏的无模型与恢复标记租约旁路。`git diff --check` 通过，仅有既有 CRLF 提示。
- Prefix Hash 语义对齐：Context 5 个测试文件 29/29 与 typecheck 通过。测试分别锁定“最后断点之后不参与 Hash”和“ContextAssembler 把最终断点移动到请求尾部后，当前 Turn 变化必须更新 Hash”；源码与架构文档已明确 Revision 表示稳定定义版本，`prefixHash` 只表示本次真实请求的缓存前缀身份。
- AgentLoopState 死声明清理：Agent 7 个测试文件 31/31 与 typecheck 通过；Agent 源码中 failed 相位、llm_error/user_timeout/user_cancel 转换及 pendingPromptId 引用归零。测试启动时仍提示 Context 旧 dist sourcemap 指向已删除的 L1 恢复旁路源码，不影响测试与类型检查结果，后续正式 build 清理 dist 即消失。
- Context L1 恢复旁路删除：Context 5 个测试文件 27/27、LocalHost L1 主召回定向 2/2 通过，Context 与 LocalHost typecheck 通过；`loadSessionNote`、`buildPostCompactionRestore`、可选 Session Note restore 预算分支及旧文件引用归零。Memory 全包 typecheck 被 K3 在途 `tasks/extraction-runner.ts` 缺少 `MemoryLeaseLostError` 导入阻塞，与本批无关；正常 L1 Recall、Memory 开关、Session Layer 1 开关和 Active Skill required restore 均保持原路径。
- KB 模型变更生命周期（外围 R12）：Knowledge 13 个测试文件 63/63、LocalHost 39 个测试文件 150/150、Desktop UI 28 个测试文件 119/119 通过；Knowledge build、LocalHost 与 Desktop UI typecheck 通过。`kb.models` 设置的 embed 引用变更现在自动失效全部已注册 KB：`KbManager.invalidateAllEmbeddings` 逐库标记 stale 并清内存索引（单库失败不中断，失败 id 单独返回，未打开的库下次打开时 ensureIndex 惰性补标）；`watchKnowledgeEmbedModel` 在设置提交+快照替换后的变更事件上触发（读取的一定是已持久化新值），embed 引用未变/被移除/维度未知均不动作，连续变更按 tail 链串行。完成后发出 `kb_embeddings_staled` 引导事件（AppEvent 新变体），前端映射为"N 个文档需要重新嵌入"通知并重读文档列表让 stale 徽标立即出现。新增测试覆盖全 KB 累计/单库失败隔离/空注册表、embed 变更触发/无关键忽略/引用未变忽略/移除不动作/维度未知跳过/连续变更串行/unwatch 生效。chunk 参数 freeze 属"未来若进设置"，本批不做。`git diff --check` 通过，仅有既有 CRLF 提示。

- R8-R9 Skills：Skills 5 个测试文件 28/28、TurnExecution 8 个测试文件 24/24（4 个真实模型 Integration 按规则跳过）、Desktop UI 与 LocalHost Skill 管理定向测试各 4/4 通过。供应链摘要覆盖完整 Bundle，市场摘要从 UI/API 透传到安装事务；子 Agent 只继承父 Agent 当前仍允许的工具交集。
- R10 MCP：MCP 7 个测试文件 30/30 通过。测试覆盖 Transport 意外关闭、失败状态、缓存保留、下一次调用惰性重连、显式断开忽略迟到回调，以及 live/cache 两条 Schema 发现路径的 256 工具和 1 MiB 总量上限。
- A 类主链 Bug：LLM 11 个测试文件 131/131、Tools 6 个测试文件 30/30、Agent 7 个测试文件 31/31、Storage 27 个测试文件 126/126 通过；Skills、MCP、LLM、Tools、Storage、Agent、TurnExecution、Desktop UI、LocalHost 九模块 typecheck 通过。覆盖 ToolResultStore EEXIST 读失败与内容冲突、Usage `cancelled` 迁移和迟到终态、消费者提前关闭流、Provider 未完整流，以及 Anthropic 显式输出预算耗尽。
- LocalHost Composition Root Character/Emotion 批次：定向 5/5、LocalHost 全量 38 个测试文件 143/143、typecheck 与正式 build 通过，构建验证 96 个源码、385 个产物。测试覆盖 Live2D 外键种子顺序、重复构造幂等、缺少活动角色时激活 Ema、Emotion 使用当前角色词表及 DB 不变量失败向上抛出；`bindings.ts` 的角色内部构造归零，运行期角色切换 emitter 未改。`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Memory 溯源链（外围 R7）：Storage 27 个测试文件 124/124、Memory 11 个测试文件 44/44 通过；Memory typecheck/build、LocalHost typecheck 通过。Profile v14 新建 `memory_node_sources(node_id, source_session_id, source_turn_id, created_at)` 关联表（PK 三列，`source_turn_id` NOT NULL DEFAULT '' 规避 SQLite PK 列 NULL 互不相等的去重陷阱；跨库软引用不建 FK），存量从 `memory_node_lazy_updates` 回填（NULL session 跳过不伪造，同键取最早时间）。新增 `MemoryNodeSourcesRepo`（INSERT OR IGNORE 幂等 record、listByNode/listByNodes）；写入侧两条路径登记：`routeCandidateNode` 新建节点登记首条来源、`enqueueLazyUpdate` 为既有节点累积来源；consolidation 排水不动溯源（追加时已登记），L1 session_notes 溯源固有（session_id 主键 + 每条 entry 带 turnId），只在注释中说明不加列。新增测试覆盖迁移回填（NULL turn 归一空串、同键取最早、NULL session 跳过）、record 幂等/批量读取/CASCADE 清理、pipeline 端到端（新建与 lazy update 两条路径、多节点互不串扰）；既有回滚测试补 memory_node_sources 回滚断言；两处 profile 最新版本断言随 v14 更新。`git diff --check` 通过，仅有既有 CRLF 提示。

- LocalHost Composition Root Extension/Knowledge/Lifecycle 批次：MCP 6 个测试文件 26/26、Knowledge 12 个测试文件 60/60、LocalHost 全量 37 个测试文件 138/138 通过；MCP 与 Knowledge typecheck/build、LocalHost typecheck 与正式 build 通过，构建验证 95 个源码、381 个产物。新增 MCP 启动发现测试覆盖跳过已有缓存、确定性注册、注册后缓存和无常驻 Transport，生命周期测试覆盖 fatal 恢复、Memory 降级禁用、后台任务跟踪及无 `kb.initAll()`；两条 MCP 权限元数据测试同步补齐既有 `approval: required` 字段。`git diff --check` 通过，仅有既有 CRLF 与不可访问 pytest 缓存提示。
- Memory 判断层（外围 R6）：Memory 10 个测试文件 42/42、Memory 与 TurnExecution typecheck、Memory build 通过。embedding 归并判定改为"粗筛候选 + LLM 判定"：`planNodeDuplicateJudgments` 在事务前对 embedding ≥0.85 的疑似重复调用 `judgeDuplicateEntity`（复用 memory binding，yes/no JSON），判否或判定失败一律保守新建，事务内只执行已确定的判定，LLM I/O 不进 SQLite 事务；`judgeDuplicateEntity` 未配置模型/输出不可解析/调用失败返回 null。召回粗筛后新增 LLM 语义精选 `selectRelevantMemories`（N/M 编号引用解析为真实 id，越界引用判失败），精选不可用（未配置/失败/解析失败）回退粗筛结果——精选是增强不是门禁。新增测试覆盖判定 yes/no/不可解析/未配置/调用失败、疑似重复的归并与保守新建、精选引用解析/越界/空选/失败/无候选短路；`git diff --check` 通过，仅有既有 CRLF 提示。
- Memory 提取信任（外围 R5）：Memory 8 个测试文件 31/31、TurnExecution 与 Desktop UI typecheck、Memory build 通过。提取输出契约新增 `evidence_quote`（≥8 字逐字引用），sanitize 三层校验：缺失/过短丢弃、归一化空白后非源文本子串丢弃，LLM 负责判断与举证、代码负责验证举证真实，不引入第二道模型调用；CHAT 提取 prompt 新增排除段（临时状态与日程、一次性情绪、对话过程信息、可推导冗余结论）；未配置 memory 模型时清空 pending 前显式发出 `memory_extraction_skipped`（`MemoryBackgroundEvent` 新变体），替换静默丢弃。新增测试覆盖合法引用保留、缺失/过短/伪造/空白归一四种校验形态、未配置返回 null、CHAT 排除段、skip 事件与清空；既有 extraction-transaction harness 补齐 evidence_quote。记录无关失败：localHost typecheck 报 `createKnowledgeRuntime.ts` kbSearch 品牌 ID 与 AppBindings 接口不匹配（Sol 迁移中间态，与本批无关）；`git diff --check` 通过，仅有既有 CRLF 提示。
- Memory 使用层（外围 R4）：Memory 7 个测试文件 24/24、TurnExecution 8 个测试文件 24/24（4 个 Live Integration 按规则跳过）通过；Memory、TurnExecution、LocalHost typecheck 与两包 build 通过。Memory 召回在 `turnContext` 包 try/catch 降级（与 Narrative 同一标准），失败发出 Memory 自有的 `memory_recall_unavailable` 事件（TurnStreamEvent 自动携带），召回整体失败不再能让 Turn 起步失败；召回块时间戳从 ISO 改为"今天/昨天/N 天前"（模型不做日期算术），块尾新增"可能已过时，用前请验证"时效标注（保留"我对你的了解"陪伴框架），节点 description 与事件 body 单条 500 字符上限。新增测试覆盖降级事件与空贡献、时效标注、年龄格式、正文截断；`git diff --check` 通过，仅有既有 CRLF 提示。
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

LocalHost L0-L5、Turn/TTS/Route/HTTP 边界、Composition Root P1-P5、外围 R1-R13、A/C 类主链与 Memory 闲置维护 M1-M5 均已完成，不要重复施工。Memory 已具备动态模型设置、租约关闸、stale embedding 修复、全局逻辑字节预算、持久衰减周期、Consolidation 单节点原子提交、由活动根 Turn 抢占的轻重维护窗口、Session 删除时的 Extraction 取消和跨库来源清理，以及 LocalHost 进程内健康投影；不要恢复已删除的死配置，也不要让主动驱逐向量立即进入 repair。后续若继续 Memory，只委派前端消费 `/api/memory/health` 与退化边界事件，不把前端状态塞入 Memory，也不重写 M1-M5。不要恢复 `apps/core`、旧 Orchestrator、宽 `AppBindings` Route、TOML 设置、MCP `startAll()`、KB `initAll()` 或 `buildBindings()` 中的异步启动副作用。不要提交 Git。
```

## 维护方式

每完成一批，只更新当前阶段、工作区归属、最近验证、下一步和阻塞项。讨论过程与长篇原理写入对应 RFC/评审文档，不复制到本接力板。
