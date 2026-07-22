# EmaAgent 当前重构接力板

> 状态：临时施工记录，架构完成后删除
> 更新时间：2026-07-22
> 作用：只记录当前阶段、工作区归属、最近验证和下一步。长期规则以 `CLAUDE.md` 为准，目标设计以 `EmaRefactor.md` 为准，设计依据以 `EmaClaudeArchitectureReview.md` 为准。

## 当前阶段

根目录迁移已经结束，项目进入语义大重构阶段。现在不再继续机械搬包，也不建立第三套 Engine；下一条主线是把现有 `ConversationEngine + AgentEngine + Core Orchestrator` 收敛为唯一的 `TurnRuntime + TurnLoop`。

R2 Prompt Slot 与 R3 ContextAssembler 主链接线已经完成：Prompt、Skill Catalog、Memory Recall、Narrative Recall、历史、当前 Turn、Scratchpad、Mailbox 与 Tool Manifest 由一次不可变 Context 快照统一装配。现有渐进 Compaction、Safe Cut、Restore、响应式压缩和 Tool Manifest Snapshot 都是基线，不重新实现。

## 迁移完成事实

- 所有 Ema 产品模块均位于根 `src`；旧产品目录不再留在 `packages`。
- `packages` 目前只保留 `credential` 与 `public-http` 两个可复用技术底座。
- `conversation`、`agent`、`contracts`、`tools`、`builtinTools`、`agentContext`、`tasks`、`storage`、`sandbox`、`system`、`ui`、`live2d-react` 等均已迁入 `src`。
- 模块内部仍可保留 `@ema-agent/*` Workspace 包名；它们是编译边界，不表示公共 npm 包。
- 旧产品 `packages/...` 源码路径审计为零。测试中最后两处硬编码迁移路径已改为 `src/agent`。

## 当前工作区

开始任何新批次前必须重新运行 `git status --short` 与 `git diff`，保留用户和其他 Agent 的修改。

本轮已知未提交修改：

- `src/agent/tests/agent.integration.test.ts`：测试包路径改为 `src/agent/package.json`；
- `src/skills/tests/store.test.ts`：Skill fixture 中的旧 `packages/agent` 路径改为 `src/agent`；
- `CLAUDE.md`：迁移完成后的长期规则；
- `EmaWorkState.md`：本接力板压缩更新。
- `EmaAgentCustomPrompt.md`：供用户粘贴后删除的临时 Codex 自定义 Prompt。

当前基线最近提交：`ab28f07 feat: add tests for ToolRegistry and tool execution context`。该提交号仅用于定位，不代表其他 Agent 不会继续提交。

## 已确定的 V1 口径

- 用户顶层模式只有 `Chat/Work`；`NarrativePolicy = auto | always | off`。
- Turn 是用户交互与唯一根终态；TurnRuntime 管生命周期，TurnLoop 管 LLM/Tool 迭代。
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
Turn       用户发起的一轮根交互
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

1. 先复查 R2/R3 现有 Diff 与真实 Turn 数据流，确认迁移后没有旧路径或重复装配；
2. 冻结统一 TurnRuntime/TurnLoop 的输入、输出、终态与事件身份；
3. 让 Chat 先作为受限 Profile 接入同一循环，保留旧 ConversationEngine 为短期适配器；
4. 接入 Work Profile 后删除重复循环与 Core 业务选择；
5. 再做 Narrative Tool、AgentRun 语义、contracts 收口和前端 Chat/Work 切换。

每批只改变一个主要业务边界。不要把 Turn 统一、数据库 Schema、全仓 ID 改名和前端切换塞进同一批。

## 最近验证

- 根 `src` 与 Workspace 目录审计完成；`packages` 仅剩 `credential`、`public-http`。
- `pnpm install --offline` 已刷新迁移后的 Workspace 链接。
- 全仓 typecheck 最近结果：84/84 通过。
- `src/contracts` build 通过。
- 旧产品 `packages/...` 路径审计为零。
- `git diff --check` 通过，仅有仓库既有的 Windows CRLF 提示。
- 本次文档收口没有重复运行全量测试；用户已允许依赖迁移批次的既有绿色验证。

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
