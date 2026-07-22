# EmaAgent 当前重构接力板

> 状态：临时施工记录；架构完成后删除
> 更新时间：2026-07-22
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根 `src` 模块迁移仍在进行。R2 Prompt Slot / Tool Manifest 与 R3 ContextAssembler 已接入 Conversation、Agent 两条根 Turn 主链；Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 和可见 Tool Manifest 现在由一次 Context 快照统一装配。

当前执行顺序：

1. 复查本轮 Context 主链 Diff 与真实前后端联调行为；
2. 继续收口剩余 Ema 专属模块迁移，但不把纯目录迁移与业务语义重构混在同一批；
3. 进入统一 `TurnRuntime/TurnLoop` 的设计与接线，不再创建第三套 Engine；
4. Chat/Work 与 NarrativePolicy 的前端 Profile 切换留到 Turn 主链稳定后处理。

## 当前工作区

Conversation 与 Agent 已迁入 `src/conversation`、`src/agent`。旧 `agent-context` 与 `agent-task` 已分别机械迁入 `src/agentContext`、`src/tasks`，暂时保留原内部包名和运行语义；`packages/tools` 按当前安排暂不迁移。恢复工作后必须先重新运行 `git status --short` 和 `git diff`，不能依据本记录覆盖其他 Agent 的新改动。

当前基线最近提交：

```text
91dbfaf feat(sandbox): add sandbox module with platform detection and shell probing
8bc9450 feat: add tools framework with registration, execution, and result handling
```

当前迁移由并行工作流持续提交；开始下一批前必须重新确认 HEAD 与工作区，不能依据旧提交号推断文件归属。

## 已确定的 V1 架构口径

- 根 `src` 保存 EmaAgent 产品业务；`apps` 保存进程和交付入口；`packages` 只保留可脱离 Ema 复用的技术底座。
- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`，Narrative 是独立 RAG 能力，不是第三个 Engine。
- `TurnRuntime` 管理一次用户交互与唯一根终态；`TurnLoop` 管理 LLM、Tool 和 Result 的迭代。
- `ContextAssembler` 是模型窗口的唯一组装入口；不再创建 `ContextManager` 或 `ContextFacade`。
- `PromptAssembler` 产出显式、有序、可版本化的 `PromptSlot[]`；Hook 不再任意替换整份 messages。
- Provider 是控制面；LLM、Embed、Rerank、Vision、STT、TTS 是执行面。低层模型 API 不管理 Session/Turn。
- Tool 使用同一份不可变 `PreparedToolCall` 完成准备、审批和执行；Permission 与 Sandbox 物理分层。
- Memory 只管理长期记忆；Compaction 属于 Context；Narrative、Knowledge Base、Memory 三个数据域保持隔离。
- 已知字段使用明确 type/interface/SQL column，不使用 `meta`、`metaJson` 或万能 JSON 让调用方猜。
- Artifact 保留源码但由 V1 Feature Gate 禁用，不继续扩建业务。

## 概念边界

```text
Turn       用户发起的一轮根交互
Task       用户/模型可见的结构化工作清单项
AgentRun   一次子 Agent 实际执行
Job        KB、Vision、Embedding、Memory 等领域后台工作
Plan       只读探索后供用户批准的方案
Goal       跨 Turn 的完成条件
Schedule   Cron、事件或时间唤醒
Workflow   确定性编排多个 AgentRun/领域步骤
Team       多 Agent 成员、寻址和共享 Task
```

Plan、Goal、Schedule、Workflow、Team 和 LLM 自动审批暂列 V1.5。V1 不创建对应空包、空表或半成品 UI。

旧 `agent-task` 实际表示 Agent 运行记录：

- 根 AgentTask 投影最终删除，Turn 成为唯一根生命周期；
- 子 Agent 数据迁为 `AgentRun/AgentRunMessage`；
- AskUser/Permission Prompt 独立持久化，不属于 Task；
- KB/Vision/Embedding/Memory Job 不继承 AgentRun，也不强行进入通用 Task 表；
- 当前内存 `TodoWrite` 不与未来结构化 TaskStore 长期双轨。

## 当前主链目标

```text
Desktop / future CLI / Web / channels
                 ↓ TurnCommand + EmaStreamEvent
             TurnRuntime
                 ↓
              TurnLoop
        ┌────────┼─────────┐
        ↓        ↓         ↓
ContextAssembler LLM      Tool Pipeline
        │         │         │
PromptAssembler  Request   PreparedToolCall
Memory/Narrative Preparer  → Permission
KB Contribution → Router   → Sandbox
History + Input            → Execution
```

## R2 实施范围

R2 只处理 Prompt 与 Tool Manifest，不同时搬 Context、切换 Chat/Work 或删除 ConversationEngine。

当前进度：R2 主链接入完成。`PromptSlot`、固定 Slot 规格、`PromptAssembler` 与 revision 已建立；Skill Catalog 使用 `extension.skillCatalog` Slot；Character 负责产出 Identity/Presentation，ACT 文案不再属于 Prompt。`ToolManifestSnapshot` 已接入根 Agent 与 Subagent；Agent Skill 收窄后的可见 Manifest 也拥有独立快照，而执行仍校验原始 Registry 身份。`registerPromptsHooks` 已删除。

计划步骤：

1. 定义明确的 `PromptSlot`、`CacheScope`、`PromptTrust` 和 revision；
2. 建立 `PromptAssembler`，校验重复 Slot ID 并确定性排序；
3. 将产品固定规则、Character Identity、Character Presentation 与 ExecutionProfile 分槽；Character 负责产出角色表达指令，Prompt 只装配；
4. 将 Tool Registry 固化为一次 Turn 使用的 `ToolManifestSnapshot`；（已完成）
5. 逐步取消 `beforeLlm` Hook 对整个 messages 数组的替换；
6. 保留并扩展现有 Prompt Prefix Hash 测试；
7. 暂不删除旧 `chat/narrative/agent` 路径，等 R3/R5 接入后再统一清理。

## R2 关键安全与缓存约束

- Tool Result、网页、附件、KB、Narrative 和 Memory Recall 属于数据，不得提升成 System 指令。
- Tool Schema、Permission 审批和实际执行共享同一个 manifest/tool revision。
- Character 变化可以形成新的 Session 前缀，但不能破坏真正固定的产品安全规则。
- Skill/MCP 使用渐进披露，连接变化不能中途改写正在运行 Turn 的 Tool Manifest。
- Prompt 不声称 Plan、Team、Schedule、Artifact 或强 Sandbox 已可用，除非 Feature Gate、实现和 Tool 注册同时存在。

## R3 Context 审查结论

已重新对照 Claude 的 Context Engineering、System Prompt、Agent Loop、Memory 与 Tool Pool 文档和源码。R3 不重写现有压缩算法，先修请求装配边界：

1. 当前主动压缩发生在 Prompt、Memory、Narrative、Skill、Scratchpad 和 Mailbox 注入之前，压缩预算没有覆盖真正发送给模型的完整请求。
2. 响应式压缩的 System Prompt 保护已完成：Compactor 先分离不可压缩 system 前缀，摘要模型只处理历史，结果再原样恢复前缀。
3. 跨 Turn 工具事实重放已完成：`buildModelMessages()` 删除 Provider 私有 thinking 和 UI 展示字段，保留成对的 `tool_use/tool_result`，并过滤断电恢复后产生的孤立块。
4. Prompt 的 `global/session/turn` Slot 已有明确类型，但兼容 Hook 把全部正文压成一个带断点的 system message，当前缓存范围尚未真正映射到请求结构。
5. Memory、Narrative 和 Skill 原先通过 Hook 优先级替换整个 messages 数组；该问题已修复，核心上下文改为显式 Prompt Slot / Context Contribution，Hook 不再负责核心装配。
6. `ContextCompactor` 仍依赖旧 `TurnMode`，并从 Memory Session Note 恢复情绪/剧情状态；这与 Chat/Work、Narrative 仅为 RAG、Compaction 归 Context 的目标边界不一致。
7. `promptPrefix.ts` 再次规范化 Tool 定义，与已经建立的 `ToolManifestSnapshot` 重复；后续应直接使用 Manifest revision，不维护第二份工具身份算法。

当前实现进度：`buildPromptSnapshot()` 在 Turn 开始时冻结 Prompt；`ContextAssembler` 返回深冻结的完整请求快照，Tool 定义直接从 `ToolManifestSnapshot` 投影。`assembleCompacted()` 把固定前缀、可压缩历史、固定尾部分开交给压缩器，完整请求共同计入预算，只有历史允许进入摘要模型。Conversation 与 Agent 均已接线；Agent 每次迭代重装 Scratchpad、Mailbox 和 Skill 收窄后的 Tool Manifest，API 超限时可强制执行一次响应式压缩。Memory Planner 与 Narrative Recall 返回结构化 `ContextContribution`；Skill Catalog 属于 Prompt Slot。旧 Prompt/Narrative/Memory/Skill `beforeLlm` 核心注入链已删除，Memory Hook 只保留 `onTurnEnd` 生命周期。

R3 主实现已完成。下一步先做真实 Turn 联调和 Diff 复查，再决定是否随统一 TurnRuntime 清理 `ConversationEngine + AgentEngine` 过渡结构。Context Collapse、服务端 cache edits 和异步 Memory Prefetch 仍留到 V1 数据证明必要后评估。

## 工作规则

- 每次开始前阅读相关源码与测试，并检查 `git status`；源码和测试优先于本文。
- 保留用户及其他 Agent 的未提交改动；遇到同文件重叠先审 Diff，不做覆盖式重写。
- 纯目录迁移与业务重构分批进行。先保持行为迁移，再单独改变语义。
- 新文件使用 camelCase；类和主要组件使用 PascalCase；相对 import 保留 `.js`。
- 禁止行内动态 import、`any`、万能 `meta`、无意义 Facade/Manager/Service 和大量几行碎文件。
- 非测试业务文件首行用一句普通中文说明职责；`types.ts`、`errors.ts`、`index.ts` 不强制。
- 测试放模块 `tests/`；开发期删除过时测试，不为旧架构继续堆兼容测试。
- 不执行 `git add`、commit、push，除非用户明确要求。

## 最近验证

- `EmaClaudeArchitectureReview.md` 已覆盖 01–21、`quick-start.md` 和 `reference.md`。
- `EmaRefactor.md` 已将 Context 公共入口统一为 `ContextAssembler`，并补充 Task/AgentRun/DomainJob 区分。
- 两份文档通过 `git diff --check`。
- 两份文档已验证为 UTF-8。
- `narrative`（原 `narrative-client`）迁移并改名已完成：包名 `@ema-agent/narrative`，目录 `src/narrative`；自身 build/typecheck 通过，test 3/3；全仓 typecheck 84/84 通过；旧包名 `@ema-agent/narrative-client` 代码残留 0；提交 `d5686d8`。
- Prompt 16/16、Context 18/18、Memory 20/20、Skills 21/21、Tools 12/12、Conversation 7/7、Agent 32/32、Core 88/88 测试通过。
- Agent 的 4 项真实 API 集成测试按既有环境变量规则跳过，未计入通过数。
- Hook、Prompt、Context、Memory、Skills、Conversation、Agent 已按依赖顺序 build；Core typecheck 通过。
- `agent-context` 已迁入 `src/agentContext`：build/typecheck 通过，测试 4/4；`agent-task` 已迁入 `src/tasks`：build/typecheck 通过，测试 7/7；Agent 与 Core 直接消费 typecheck 通过。
- `git diff --check` 通过，仅有仓库既有的 Windows CRLF 提示。

## 恢复工作时使用的提示词

```text
继续 EmaAgent V1 重构。

请先完整阅读：
1. D:\Github\EmaAgent\CLAUDE.md
2. D:\Github\EmaAgent\EmaRefactor.md
3. D:\Github\EmaAgent\EmaWorkState.md

需要了解设计理由时，阅读：
D:\Github\EmaAgent\EmaClaudeArchitectureReview.md 中与当前阶段相关的章节。

先检查 git status、当前 diff 和最近提交，保留用户及其他 Agent 的改动。
先复查尚未提交的 R3 Context 主链接线与验证记录；确认没有回归后，再进入统一 TurnRuntime/TurnLoop，不要重新实现 Prompt Slot、Context Contribution 或旧 beforeLlm 注入链。
修改前先说明当前事实、模块边界和本轮范围。不要提交 Git。
```

## 维护方式

每完成一批，只更新以下内容：

- 当前阶段；
- 当前工作区归属；
- 已完成；
- 最近验证；
- 下一步与阻塞项。

不要把讨论过程、长篇原理或完整 Git Log 复制进来。架构决策回写 `EmaRefactor.md`，设计依据回写 `EmaClaudeArchitectureReview.md`。全部重构完成后删除本文件。
