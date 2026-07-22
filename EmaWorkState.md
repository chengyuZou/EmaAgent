# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-07-22
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。现在不再继续机械搬包，也不建立第三套 Engine；下一条主线是把现有 `ConversationEngine + AgentEngine + Core Orchestrator` 收敛为唯一的 `TurnRuntime + TurnLoop`。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

Prompt 装配边界已经完成新语义收口：公共入口只接受全局 Active Character、`ExecutionProfile`、`NarrativePolicy` 与显式扩展贡献；旧 `buildSystemPrompt`、`buildModeBlock`、`legacyExecutionProfile` 和工作区路径注入已删除。Prompt 源码不再依赖 `contracts`，Skill Catalog 只在 Work Profile 作为扩展 Context 提供。运行时历史、召回、附件和工作区事实继续由 Context 所有。

Prompt 缓存边界已进一步落到真实模型请求：稳定范围改为 `product / activeCharacter / turn`，全局激活角色不是 Session 绑定；产品规则与全局角色各自形成 System Block 和缓存断点，Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部。Skill Catalog 作为普通 Context Message 投递并限制为 8000 字符总预算、250 字符单项描述，不能取得 System 权限。Context 会冻结日期、平台、工作区和模型身份，并输出分层 Prompt Revision、Tool Manifest Revision 与 Prefix Hash。Anthropic Adapter 已支持保留多层 System Block，不再由后一条覆盖前一条。

统一 Turn 主线的前三刀已经完成：公网请求使用 `trigger + executionProfile + narrativePolicy`；Agent 内部循环已改名为通用 `turnLoop`；Session/Turn SQL 显式保存触发来源、执行 Profile 与 Narrative 策略；Desktop 顶层选择器只显示 Chat/Work，Narrative 改为 `auto/always/off` 二级策略。Session REST、发送队列、`turn_started` SSE 与历史展示均直接使用新契约，不再经过旧 Mode 映射。旧 `chat/narrative/agent` 只留在尚未统一的 Engine、Hook/Compaction 输入和少量内部兼容投影。

Provider 配置也已完成旧列清理：顶层 `base_url`、`config_json`、`capabilities_json` 被物理删除，地址、协议和能力开关只保存在 `provider_capability_configs`。Session/Turn 无业务读取的 `meta_json` 同步删除；Message、MCP、Artifact 等仍有明确用途的 JSON 未动。

## 迁移完成事实

- 所有 Ema 产品模块均位于根 `src`；旧产品目录不再留在 `packages`。
- `packages` 目前只保留 `credential` 与 `public-http` 两个可复用技术底座。
- `conversation`、`agent`、`contracts`、`tools`、`builtinTools`、`agentContext`、`tasks`、`storage`、`sandbox`、`system`、`ui`、`live2d-react` 等均已迁入 `src`。
- 模块内部仍可保留 `@ema-agent/*` Workspace 包名；它们是编译边界，不表示公共 npm 包。
- 旧产品 `packages/...` 源码路径审计为零。测试中最后两处硬编码迁移路径已改为 `src/agent`。

## 当前工作区

开始任何新批次前必须重新运行 `git status --short` 与 `git diff`，保留用户和其他 Agent 的修改。

本轮已知未提交修改：

- `src/prompts`：删除旧三 Mode 兼容入口，改为 `promptBuilder + promptAssembler + executionProfilePrompt`；
- `src/skills`：Skill Catalog 改为按 Work Profile 提供 Prompt Contribution；
- `apps/core`：Prompt 构建直接传入 Turn 的 Profile 与 NarrativePolicy，不再把工作区路径写进 System Prompt；
- `pnpm-lock.yaml`：刷新 Prompt/Skills 的 Workspace 依赖；
- `EmaClaudeArchitectureReview.md`：由其他 Agent 修改，本批未触碰；
- `src/ui/vite.config.ts.timestamp-*.mjs`：无关未跟踪临时文件，本批未触碰。

当前基线最近提交：`ab28f07 feat: add tests for ToolRegistry and tool execution context`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是一次有明确触发原因与唯一终态的有界 Agent 执行；V1 只接用户消息触发。TurnRuntime 管生命周期，TurnLoop 管 LLM/Tool 迭代。
- 未来 Realtime/读屏/主动说话/直播属于长生命周期媒体或唤醒能力，不是新 Mode，也不能成为一个永不结束的 Turn；V1 暂不实现。
- Narrative 是保留多周目 Query Route 和专用前端 Block 的独立 RAG 能力，不是第三个 Engine。
- ContextAssembler 是模型窗口唯一组装入口；PromptAssembler 只产出显式、有序、可版本化的 PromptSlot。
- Provider 是控制面；LLM、Embed、Rerank、Vision、STT、TTS 是无 Session 状态的执行面。
- Tool 使用同一份不可变 PreparedToolCall 完成准备、审批和执行；Permission 与 Sandbox 物理分层。
- Memory 只管理长期记忆；Compaction 属于 Context；Narrative、Knowledge Base、Memory 保持隔离。
- `src/contracts` 从现在起只减不增。业务类型、ID、事件与错误回归各自所有者；Turn 只组合跨端事件。
- 已知字段使用明确 type/interface/SQL column，不用 `meta`、`metaJson` 或万能 JSON 让调用方猜。
- Artifact 保留源码但由 V1 Feature Gate 禁用。

## 概念边界

```text
Turn       一次由明确来源触发、具有唯一终态的有界 Agent 执行
Task       用户/模型可见的结构化工作清单项
AgentRun   一次 Agent 或 Subagent 实际执行
Job        KB、Vision、Embedding、Memory 等领域后台工作
Plan       只读探索后供用户批准的方案
Goal       跨 Turn 的完成条件
Schedule   Cron、事件或时间唤醒
Workflow   确定性编排多个 AgentRun 或领域步骤
Team       多 Agent 成员、寻址与共享 Task
```

Plan、Goal、Schedule、Workflow、Team 与 LLM 自动审批暂列 V1.5，不创建空包、空表或半成品 UI。

## 下一批建议顺序

1. 让 Context、Compaction、Hook 与 Memory 输入迁出旧 `TurnMode`，使用 `ExecutionProfile`、`NarrativePolicy` 或明确领域事实；
2. 建立 Chat/Work 的不可变 Tool Manifest 与迭代策略，再实现 Narrative `always/auto/off`；
3. 清理根 AgentTask 投影、AgentRun 身份和 Core 外围业务边界；
4. 外围契约稳定后再组装唯一 `TurnRuntime + TurnLoop`，删除 ConversationEngine 与 AgentEngine 外壳。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

- 根 `src` 与 Workspace 目录审计完成；`packages` 仅剩 `credential`、`public-http`。
- `pnpm install --offline` 已刷新迁移后的 Workspace 链接。
- 全仓 typecheck 最近结果：84/84 通过。
- `src/contracts` build 通过。
- 旧产品 `packages/...` 路径审计为零。
- 新 Turn 契约完成后，`@ema-agent/turn` build 通过；Agent、Core、Desktop UI typecheck 通过。
- Agent 测试 32/32 通过，4 个 Live Integration 测试按既有规则跳过。
- Core 测试 88/88 通过；Desktop UI 测试 128/128 通过。
- Data v15 与 Profile v10 迁移通过：Session/Turn 新字段已落盘，Provider 和 Session/Turn 遗留列已物理删除。
- Storage 测试 118/118、Session 测试 39/39、Backup 测试 10/10 通过。
- Chat/Work 前端切换批次：Turn、Session、Contracts build 通过；Agent、Conversation、Core、Desktop UI typecheck 通过。
- 本批 Core 测试 88/88、Desktop UI 测试 130/130、Session 测试 39/39、Agent 测试 32/32、Conversation 测试 7/7 通过；4 个 Agent Live Integration 测试按既有规则跳过。
- Prompt 新边界：Prompt 测试 6/6、Skills 测试 21/21、Core 测试 88/88、全仓 typecheck 84/84 通过。
- Prompt 分层请求：Prompt 6/6、Context 21/21、LLM 126/126、Skills 23/23、Agent 32/32、Conversation 7/7、Core 88/88 通过；Agent 4 个 Live Integration 按既有规则跳过。
- `git diff --check` 通过，仅有仓库既有的 Windows CRLF 提示。

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
