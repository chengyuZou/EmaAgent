# EmaAgent 当前重构接力板

> 状态：临时施工记录；架构完成后删除
> 更新时间：2026-07-21
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根 `src` 模块迁移仍在进行。`narrative-client` 已完成迁移并改名为 `src/narrative`（包名 `@ema-agent/narrative`，类名 `NarrativeClient` 等保持不变）。R2 的 Prompt Slot 与 Tool Manifest 已完成首轮实现和主链接入，下一阶段进入 R3 ContextAssembler 边界收口。

当前执行顺序：

1. 继续收口剩余 Ema 专属包迁移（memory / knowledge / skills / mcp / marketplace / characters / sessions / tools / tool-builtin / permission / conversation / agent / agent-task / agent-context / hook / contracts 按需）；
2. 收口 R2 遗留兼容入口，但不在 R3 前删除旧路径；
3. R3 `ContextAssembler + Compaction`，先定义结构化贡献与唯一装配入口；
4. 统一 `TurnRuntime/TurnLoop`，不提前改前端 Profile。

## 当前工作区

记录时的 Git 状态：

```text
M  EmaClaudeArchitectureReview.md
M  packages/character-card/src/index.ts
M  packages/character-card/tests/store.spec.ts
M  src/prompts/build.ts
M  src/prompts/index.ts
M  src/prompts/tests/build.spec.ts
?? EmaWorkState.md
?? packages/character-card/src/characterPrompt.ts
?? src/prompts/errors.ts
?? src/prompts/promptAssembler.ts
?? src/prompts/tests/promptAssembler.test.ts
?? src/prompts/types.ts
```

判断：`src/prompts` 下新增 `promptAssembler.ts` / `types.ts` / `errors.ts` 与测试，R2 Prompt Slot 已有 Agent 在动工；`packages/character-card` 同步在改（新增 `characterPrompt.ts`）。恢复工作后必须先重新运行 `git status --short` 和 `git diff`，确认最新归属，不能依据本快照覆盖或删除改动。

最近一次提交：

```text
d5686d8 fix: narrative换目录
9ec9588 feat: restructure artifact and attachment packages
```

`narrative` 已由 `d5686d8` 完成目录迁移与改名；`artifact` 与 `attachment` 由 `9ec9588` 完成结构迁移。除非发现明确回归，不要重新搬一次。

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

当前进度：R2 首轮完成。`PromptSlot`、固定 Slot 规格、`PromptAssembler` 与 revision 已建立；产品固定规则和 Tool Guidance 已成为稳定 Slot；Character 负责产出 Identity/Presentation，ACT 文案不再属于 Prompt。`ToolManifestSnapshot` 已接入根 Agent 与 Subagent，模型定义、prepare 和执行使用同一份 Registry 来源快照。旧 `TurnMode` 已隔离在兼容模块，`registerPromptsHooks` 暂留到 R3/R5 接线完成后删除。

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
5. Memory、Narrative 和 Skill 仍通过 Hook 优先级直接替换整个 messages 数组；顺序属于隐式全局约定，也无法证明一次 LLM Call 使用的是同一份不可变上下文快照。
6. `ContextCompactor` 仍依赖旧 `TurnMode`，并从 Memory Session Note 恢复情绪/剧情状态；这与 Chat/Work、Narrative 仅为 RAG、Compaction 归 Context 的目标边界不一致。
7. `promptPrefix.ts` 再次规范化 Tool 定义，与已经建立的 `ToolManifestSnapshot` 重复；后续应直接使用 Manifest revision，不维护第二份工具身份算法。

当前实现进度：`buildPromptSnapshot()` 已让新主链直接取得 Prompt 版本快照；`ContextAssembler` 已建立明确输入并返回深冻结的完整请求快照，Tool 定义直接从 `ToolManifestSnapshot` 投影。`assembleCompacted()` 已按固定前缀、可压缩历史、固定尾部调用压缩器，三部分共同计入预算，只有历史允许进入摘要模型。Memory Planner 与 Narrative Recall 已改为返回带来源、唯一 ID 和插入位置的 `ContextContribution`；旧 Hook 目前只保留兼容投影，等待 Engine 接线后删除。Skill 仍属于 Prompt Slot，不混入数据贡献。

R3 建议顺序：先把 System Prompt 与可压缩历史从类型上分离，并修复工具调用/结果的安全重放；再建立返回不可变完整请求视图的 `ContextAssembler`；随后让 Memory/Narrative/Skill 返回结构化贡献，最后删除旧 `beforeLlm` messages replace 链。Context Collapse、服务端 cache edits 和异步 Memory Prefetch 仍留到 V1 数据证明必要后评估。

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
- Prompt 测试 17/17 通过，Prompt build 与 Core typecheck 通过。
- Tools 测试 12/12 通过；Tool Manifest 已验证稳定排序、深冻结、来源校验及 MCP 同名热更新失效。
- Agent typecheck 通过，非 Live 集成测试 31/31 通过；4 项真实 API 集成测试按既有规则跳过。
- Context 测试现为 18/18；Memory 测试 20/20；Conversation 测试 7/7。Context、Memory、Conversation typecheck 均通过。

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
先收口正在进行的 narrative-client 机械迁移；如果它已经由其他 Agent 完成，则审查迁移结果和验证记录，然后进入 R2 Prompt Slot。
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
