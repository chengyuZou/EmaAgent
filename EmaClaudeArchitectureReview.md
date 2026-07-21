# EmaAgent 与 Claude Code 架构逐章对照

> 状态：持续审阅中，按 `how-claude-code-works/docs` 的章节顺序逐篇核对  
> 日期：2026-07-21  
> 目的：区分可直接学习的工业边界、Ema 当前已经具备的能力、真实缺口，以及 V1 不应照搬的功能  
> 证据优先级：Ema 实际源码与测试 > `EmaRefactor.md` 目标设计 > Claude Code 源码快照 > 逆向文档中的推断

## 阅读方法与结论标记

每章固定回答五个问题：

1. Claude 解决的业务问题是什么；
2. Ema 当前由哪些源码承担；
3. 两者的真实 Diff；
4. 重构时应该拆到哪里；
5. 它与前面章节通过什么接口连接。

结论使用以下标记：

- **V1 必做**：当前产品主链路或发布安全边界；
- **V1 收口**：已有实现需要统一或去耦，不扩建新产品能力；
- **V1.5 候选**：接口可预留，但现在不建立空包、空表或半成品 UI；
- **不照搬**：Claude 的 CLI、编码或云端业务专属设计，不适合直接复制。

---

## 01 概述：Agent-first 与统一执行核心

### Claude 的业务与架构

Claude Code 把自身定义为受控工具循环 Agent，而不是聊天接口或代码补全器。它的稳定核心是一个不依赖 UI 的 `query()` 异步生成器；REPL、`-p` 和 SDK 等不同入口最终都驱动同一个循环。循环编排模型调用、上下文压缩、工具执行与恢复，UI 只消费流式事件。启动阶段又把关键路径、延迟初始化和重依赖加载明确分开。

### Ema 当前事实

Ema 已经具备与这条主链大部分对应的模块：

```text
Desktop / apps/core route
        ↓
ConversationEngine 或 AgentEngine
        ↓
LLM + Context + Tools + Permission + Hook
        ↓
AsyncIterable<EmaStreamEvent>
```

已有优势：

- `Turn`、结构化 SSE 和 `AsyncIterable<EmaStreamEvent>` 已建立；
- Provider 与各模型执行面已经分离，低层模型调用不感知 Session；
- Permission 与 Sandbox 已物理分层；
- Desktop、TS Sidecar、Python Bridge 的部署边界比单进程 CLI 更清楚；
- 产品从一开始就有桌面 UI、角色、Memory、KB 和 Narrative，不必复制终端 REPL。

当前主要偏差：

- `ConversationEngine` 与 `AgentEngine` 仍是两套循环，Chat/Work 尚未汇聚到唯一执行核心；
- `apps/core` 的 route/wiring 仍承载部分业务编排，入口层边界不稳定；
- 模块正在从 `packages` 搬往根 `src`，调用方仍可能穿透旧包内部；
- 启动、自检、依赖 readiness 与延迟加载尚未形成一条可审计的 Composition Root 流程；
- 前端、Core 与 Agent 之间仍残留旧 `mode`、`AgentTask` 和多套消息类型。

### Diff 判断

1. **V1 必做：统一 TurnEngine。** Chat 与 Work 必须共享同一个循环，只通过 Profile 控制迭代预算和工具能力。不能继续维护第三套 Engine。
2. **V1 必做：核心循环不依赖入口。** Desktop、未来 CLI/Web/QQ/微信只负责把输入规范化为 Turn，并消费事件；不得复制业务循环。
3. **V1 收口：Core 退回 Sidecar BFF。** Route 只解析、校验、认证和转换 SSE，业务编排进入根 `src` 的产品模块。
4. **V1 收口：建立明确启动阶段。** Tauri 管 Sidecar 生命周期；Core Composition Root 负责数据库迁移、凭据、Provider Runtime、Tool Registry 和 Bridge readiness；非关键目录扫描、Catalog 刷新和遥测延迟执行。
5. **不照搬：集中式巨型全局 State。** Ema 多 Session 并行且有桌面多窗口，不应复制 Claude 单会话 CLI 的 150+ getter/setter 全局状态。Session/Turn 状态必须显式按 ID 隔离。
6. **不照搬：Bun 编译期 Feature Flag。** Ema 使用 NodeNext/Tauri/Turbo，V1 继续使用明确 Feature Gate 与构建入口，不引入第二套 bundler 宏体系。

### 建议拆分

```text
src/agent/
├─ turnEngine.ts          唯一模型工具循环
├─ loop/                  单次迭代与状态转换
├─ profiles/              Chat/Work 能力策略
├─ recovery/              API、上下文和工具恢复
└─ runs/                  仅 Agent/Subagent 实际运行

src/turn/                 Turn 命令、身份、终态与组合事件
src/context/              发给模型的窗口和压缩
src/tools/                工具准备与执行
apps/core/                HTTP/SSE/认证/装配
```

### 与后续章节的接口

- 第 2 章应具体定义 `TurnEngine` 与单次循环状态，不能重新发明会话引擎；
- 第 3 章的 Context 只向循环提供模型请求视图，不拥有 Session；
- 第 4、11 章的 Tool/Permission 通过不可变 PreparedToolCall 接入循环；
- 第 12 章前端只能消费事件和发送命令；
- 第 15、21 章的 Task、AgentRun、Job 和后台 Session 不能重新混进 Turn 根生命周期。

---

## 全局边界表（随阅读更新）

| 概念 | Ema 唯一含义 | 当前目标所有者 |
|---|---|---|
| Turn | 用户发起的一轮交互和唯一根终态 | `src/turn` + `src/agent/turnEngine` |
| Task | 模型维护的工作清单项 | `src/tasks`（尚未实现） |
| Plan | 只读探索后供用户审批的实施方案 | V1.5 候选，暂不建包 |
| AgentRun | 一次 Agent/Subagent 实际执行 | `src/agent/runs`（待从旧 agent-task 拆出） |
| Job | KB、Vision、Embedding 等领域后台工作 | 各领域内部 |
| Schedule | Cron、唤醒与循环触发 | V1.5 候选，暂不建包 |
| Goal | 跨 Turn 的停止条件 | V1.5 候选，暂不建包 |

