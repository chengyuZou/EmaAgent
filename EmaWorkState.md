# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-07-23
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。现在不再继续机械搬包，也不建立第三套 Engine；下一条主线是把现有 `ConversationEngine + AgentEngine + Core Orchestrator` 收敛为唯一的 `TurnRuntime + TurnLoop`。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

Prompt 装配边界已经完成新语义收口：公共入口只接受全局 Active Character、`ExecutionProfile`、`NarrativePolicy` 与显式扩展贡献；旧 `buildSystemPrompt`、`buildModeBlock`、`legacyExecutionProfile` 和工作区路径注入已删除。Prompt 源码不再依赖 `contracts`，Skill Catalog 只在 Work Profile 作为扩展 Context 提供。运行时历史、召回、附件和工作区事实继续由 Context 所有。

Prompt 缓存边界已进一步落到真实模型请求：稳定范围改为 `product / activeCharacter / turn`，全局激活角色不是 Session 绑定；产品规则与全局角色各自形成 System Block 和缓存断点，Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部。Skill Catalog 作为普通 Context Message 投递并限制为 8000 字符总预算、250 字符单项描述，不能取得 System 权限。Context 会冻结日期、平台、工作区和模型身份，并输出分层 Prompt Revision、Tool Manifest Revision 与 Prefix Hash。Anthropic Adapter 已支持保留多层 System Block，不再由后一条覆盖前一条。

Context 的缓存链已经补齐请求尾部断点：最终模型请求的最后一条非空消息会获得仅存在于只读投影中的动态 `cacheBreakpoint`，历史和已完成 Tool Round 因此能够进入下一次调用的缓存前缀；该标记不写回 Session、Turn 工作消息或压缩历史。

Compaction 已迁出旧三 Mode：摘要结构只由 `ExecutionProfile = chat | work` 决定，`NarrativePolicy` 随事件保留但不选择第三套模板。Macro 使用可丢弃的 `<analysis>` 草稿提升摘要质量，只把 `<summary>` 写入上下文；Safe Cut 已合并为按 `toolUseId` 检查整段 tail 的单一算法，支持工具消息之间插入附件，同时阻止孤立 `tool_result`。

Prompt/Context 的 V1 目录边界已经规范化：`contextSnapshot.ts` 独立拥有单次模型调用的不可变输入、输出与缓存诊断，`types.ts` 只保留 Contribution 和压缩协作契约；`slots.ts` 独立拥有 Slot 身份、顺序、稳定范围、投递方式与信任级别。Context Contribution 公共请求已移除 `TurnMode`，直接使用 `ExecutionProfile + NarrativePolicy`；Memory 公开召回入口接收新契约，旧检索分区的临时映射收回 Memory 内部。

统一 Turn 主线的前三刀已经完成：公网请求使用 `trigger + executionProfile + narrativePolicy`；Agent 内部循环已改名为通用 `turnLoop`；Session/Turn SQL 显式保存触发来源、执行 Profile 与 Narrative 策略；Desktop 顶层选择器只显示 Chat/Work，Narrative 改为 `auto/always/off` 二级策略。Session REST、发送队列、`turn_started` SSE 与历史展示均直接使用新契约，不再经过旧 Mode 映射。旧 `chat/narrative/agent` 只留在尚未统一的 Engine、Hook、Memory 输入和少量内部兼容投影。

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

V1 Task 后端主链已经完成：`src/tasks` 只保存跨 Turn 的用户/模型可见工作项，Data v18 使用显式 Task 列、Session 内短序号、依赖关系和 CAS；根 Work Turn 注册 TaskCreate/Get/List/Update，旧内存 TodoWrite 已删除。Task 事件、低频动态 Context 提醒、`/api/tasks` 重启快照和 Session ZIP 备份恢复已经接线；独立前端 TaskList 仍是下一批。

Task 与子 Agent 的 V1 边界已经进一步冻结：四个 Task Tools 只向根 Turn 注册；普通 Subagent 不读取或修改共享 Task List。根 Agent 可用可选 `taskId` 启动一次 AgentRun，绑定前必须验证同 Session、未终态、无未完成依赖且没有其他活动 Run；不带 `taskId` 的临时调查合法。AgentRun 成功、失败或取消只结束执行并释放活动绑定，不自动完成、取消或删除 Task；父 Turn 验证结果后再显式 `TaskUpdate`。Claude 的 Task `owner` 属于 Team Member 语义，Ema V1 不用临时 `AgentRunId` 冒充长期 owner。

AgentRun 语义收口已经完成：旧 `src/tasks` 运行记录、根 Turn 的 AgentTask 投影及 `AgentTurnLifecycleFacade` 已删除；Data v17 只把真实子执行迁入 `agent_runs/agent_run_messages`。Subagent 内部和模型工具返回值统一使用 `agentRunId`，Tool Journal 同时保存父 `turnId` 与可选 `agentRunId`，不再互相冒充；普通 Subagent 已移除 TodoWrite。客户端 SSE 暂时保留 `subagentId` 字段名，旧 `/api/agent-tasks` 暂时作为前端兼容适配，不代表后端仍存在 AgentTask 领域。

Session 历史语义已经收口：Data v19 删除 `branches`、`sessions.active_branch_id`、`turns.branch_id` 与对应 Repo/协议/UI。侧栏 Fork 完整复制 Session；已完成回复下的 Fork 按 `untilTurnId` 复制到该轮（含）为止并切换到独立 Session。用户气泡只允许回滚最后一个非运行 Turn 后重发；任意 Turn 删除、BranchPanel、`<N/M>` 导航和延迟分叉状态机均已删除。旧 Binary Lifting、Euler Tour + RMQ、恢复算法与前端布局已原样保存在 `D:\Github\EmaAgentBranchArchive`，36 个源码文件的 SHA-256 已与删除前版本逐一校验。

## 迁移完成事实

- 所有 Ema 产品模块均位于根 `src`；旧产品目录不再留在 `packages`。
- `packages` 目前只保留 `credential` 与 `public-http` 两个可复用技术底座。
- `conversation`、`agent`、`tools`、`builtinTools`、`agentContext`、`tasks`、`storage`、`sandbox`、`system`、`ui`、`live2d-react` 等产品模块均位于 `src`；旧 `contracts` 已收口删除，旧 `tasks` 运行记录语义已由真正的持久工作项替代。
- 模块内部仍可保留 `@ema-agent/*` Workspace 包名；它们是编译边界，不表示公共 npm 包。
- 旧产品 `packages/...` 源码路径审计为零。测试中最后两处硬编码迁移路径已改为 `src/agent`。

## 当前工作区

开始任何新批次前必须重新运行 `git status --short` 与 `git diff`，保留用户和其他 Agent 的修改。

当前工作区包含既有 V1 Task/AgentRun 改动，以及本批 Session Branch 删除、Data v19、独立 Session Fork、最后一轮回滚、Desktop 投影和架构文档更新；未暂存、未提交。

当前基线最近提交：`592c78b refactor: remove AgentTaskStore and related files; update telemetry retention test user_version to 17`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是一次有明确触发原因与唯一终态的有界 Agent 执行；V1 只接用户消息触发。TurnRuntime 管生命周期，TurnLoop 管 LLM/Tool 迭代。
- 未来 Realtime/读屏/主动说话/直播属于长生命周期媒体或唤醒能力，不是新 Mode，也不能成为一个永不结束的 Turn；V1 暂不实现。
- Narrative 是保留多周目 Query Route 和专用前端 Block 的独立 RAG 能力，不是第三个 Engine。
- ContextAssembler 是模型窗口唯一组装入口；PromptAssembler 只产出显式、有序、可版本化的 PromptSlot。
- Provider 是控制面；LLM、Embed、Rerank、Vision、STT、TTS 是无 Session 状态的执行面。
- Tool 使用同一份不可变 PreparedToolCall 完成准备、审批和执行；Permission 与 Sandbox 物理分层。
- V1 完整实现持久 Task：TaskCreate/Get/List/Update、依赖、AgentRun 可选绑定、事务/CAS、事件、Context 提醒、恢复快照与独立前端 TaskList；Task Tools 只属于根 Turn，TodoWrite 完成迁移后删除。
- 后台 Shell 是 BackgroundProcess，使用 ProcessOutput/ProcessStop；不复用 TaskId、AgentRunId 或领域 Job 生命周期。
- Memory 只管理长期记忆；Compaction 属于 Context；Narrative、Knowledge Base、Memory 保持隔离。
- branded ID 只允许进入零业务依赖的 `src/ids`；业务类型、状态、事件与错误仍归各自所有者，Turn 只组合跨端事件。
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

1. 前端新增独立 TaskList，消费 Task 结构化事件并在窗口重开时读取 `/api/tasks` 快照；
2. 按已冻结的四按钮/动态工作标签设计重构 Chat 右侧与底部工作区，不恢复旧 Branch 面板；
3. 前端迁到 AgentRun/Task 新协议后，删除 `/api/agent-tasks` 与 `subagentId` 旧命名兼容；
4. 后台进程按 `BackgroundProcess + ProcessOutput/ProcessStop` 分批实现 C 档，不修改 Agent Loop 来实现自动后台化；
5. Chat 接入统一 TurnLoop 放在 Tool 单次执行边界稳定之后，短期保留 ConversationEngine 适配器。

命名随业务批次清理：`IFileStateStoreEntry`、`IFileStateStore`、`IToolExecutionJournal` 等迁移期 `I*` 类型在其所有权迁移时改为职责名，不单独进行全仓机械重命名。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

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

目录迁移已经结束，不要继续机械搬包。R2 Prompt Slot 与 R3 ContextAssembler 已完成，不要重写。当前从统一 TurnRuntime/TurnLoop 主线推进；修改前先核对真实调用链并说明本批边界，不要提交 Git。
```

## 维护方式

每完成一批，只更新当前阶段、工作区归属、最近验证、下一步和阻塞项。讨论过程与长篇原理写入对应 RFC/评审文档，不复制到本接力板。
