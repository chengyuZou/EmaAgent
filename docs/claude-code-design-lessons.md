# Claude Code 设计借鉴笔记

> 通读 `D:\Github\claude-code\docs` 全部架构文档后的精炼综述，专门服务于 EmaAgent V1 的 AgentEngine / ToolRegistry / PermissionEngine 设计。
>
> 每一节按「机制 → 为什么这样设计 → EmaAgent 借鉴策略（采纳 / 改造 / 跳过）」组织。

---

## 0. 总体哲学（最先记住的几条）

1. **每一步都产生 API 不可预知的真实信息** — 工具结果是 LLM 无法预测的（命令输出、文件内容、错误）。因此 agent 必须是「think → act → observe → 再 think」的增量循环，**不能是 plan-once-execute-batch**。
2. **state 永远不可变重建** — 每次 `continue` 创建新 `State` 对象，`transition` 字段记录「这次为什么继续」。让后续迭代能识别自己是否陷入恢复循环。
3. **缓存字节一致性是架构约束** — claude-code 的多个小决策（boundary 位置、`backfillObservableInput` 只在新增字段时克隆、fork placeholder 完全一致）都是为了保住 prefix cache。EmaAgent 接 Anthropic API 时同样适用。
4. **工具输出是数据不是命令** — 永远不信任工具结果里的指令性文字；prompt injection 防御的根基。
5. **权限和沙箱是两层防御** — 权限决定「要不要执行」；沙箱决定「就算执行了能碰到什么」。两层叠加才有 defense-in-depth。

---

## 1. Agent 主循环（最核心）

### 机制

`queryLoop()` 是 `while(true)` async generator。每次迭代有四个阶段：

```
Phase 1  消息预处理流水线（5 个串行步骤）
  applyToolResultBudget     — 截断超大工具结果
  snipCompactIfNeeded       — 历史截断
  microcompact              — 工具结果摘要
  applyCollapsesIfNeeded    — 上下文折叠
  autocompact               — 整体压缩（超阈值）

Phase 2  流式 API 调用
  deps.callModel() 返回 AsyncGenerator
  - 收集 AssistantMessage[]
  - 提取 tool_use blocks → 设置 needsFollowUp = true
  - StreamingToolExecutor 在流期间就启动工具执行
  - 可恢复错误（prompt_too_long / max_output_tokens）暂扣（withheld）

Phase 3  工具执行
  并行安全工具走 streamingToolExecutor.getRemainingResults()
  非并行安全走 runTools()

Phase 4  终止或继续
  needsFollowUp ? continue (新 State) : return { reason }
```

### 终止原因（13 种 reason，每一种都是显式命名）

| reason | 触发条件 |
|---|---|
| `completed` | 正常：无 tool_use，stop hooks 通过 |
| `next_turn` | 继续：有 tool_use，追加结果 |
| `max_turns` | 超过轮次上限 |
| `aborted_streaming` / `aborted_tools` | 用户中断 |
| `prompt_too_long` | 413 错误且 reactive-compact 救不了 |
| `model_error` | 不可恢复 API 错误 |
| `max_output_tokens_escalate` → `max_output_tokens_recovery` | 输出截断恢复（先升 64K，再注入「resume directly」） |
| `collapse_drain_retry` → `reactive_compact_retry` | PTL 两级降级 |
| `stop_hook_blocking` / `stop_hook_prevented` | hook 控制流 |
| `hook_stopped` | 工具执行中 hook 阻断 |

**关键 transition 字段**：每次 continue 都记录上一次为什么继续，避免相同恢复路径反复触发（例如 `hasAttemptedReactiveCompact` flag）。

### StreamingToolExecutor

不等流结束。`content_block_stop` 触发 tool_use 完成 → 立刻 yield AssistantMessage + 提交给 executor。`isConcurrencySafe` 的工具并行，副作用工具串行。流结束时多个工具可能已完成。

### 流式监控（双层）

- **被动 stall 检测**：30s 无事件记日志（不中断）
- **主动 idle watchdog**：90s 无事件抛错中断

### 模型 fallback

`FallbackTriggeredError` → 清掉 assistantMessages → 合成「Model fallback triggered」tool_result 给未完成的 tool_use → 剥离 thinking-signature（签名是模型绑定的，跨模型 replay 会 400）→ 切换 fallbackModel → 系统消息「Switched to X due to high demand for Y」→ 重启流式请求。

### EmaAgent 借鉴策略

| 项 | 策略 |
|---|---|
| `while(true)` + 不可变 State | **采纳**。你 v0.4 原型的 `AgentRuntimeState` 已经接近，V1 改为每次重建。 |
| `transition` 命名字段 | **采纳**。每种 continue 原因显式命名（`next_turn` / `max_output_recovery` / `tool_error_retry`…）便于调试。 |
| 13 种终止 reason 全采纳 | **改造**。先做 6 种核心（completed / next_turn / max_turns / aborted / model_error / max_output），错误恢复后续补。 |
| StreamingToolExecutor 流期间启动 | **改造**。V1 先做你 v0.4 已有的「`_act()` 阶段并行只读工具」，更激进的流期间执行作为 P1。 |
| 90s idle watchdog | **采纳**。`packages/llm` adapter 里加入。 |
| 模型 fallback + thinking-signature 剥离 | **采纳**。LlmRouter 接住 529 错误后必须剥离 signature。 |

---

## 2. 上下文管理（Compaction）

### 三层压缩策略

| 层 | 触发 | 调 API？ | 说明 |
|---|---|---|---|
| **MicroCompact** | 单个工具输出过大 | 否 | 清空老的工具结果，消息列表本身不动 |
| **Session Memory Compact** | autocompact 命中且 feature flag 开 | 否 | 用预抽取的 Session Memory 作为摘要 |
| **Traditional API summary** | `/compact` 命令或 SM 不可用 | 是 | 用 summarizer 模型总结历史 |

### 关键不变量

API 要求每个 `tool_result` 必须有对应的 `tool_use`，否则 400。`adjustIndexToPreserveAPIInvariants()` 从切割点向前扫描，把以下东西拉回来：
1. 保留 tool_results 引用的 tool_use IDs
2. 与保留 assistant 消息同 `message.id` 的 thinking blocks

### Token 预算分配（200K 窗口示例）

```
Context window 200K
├─ System prompt           ~15-25K  (重度缓存)
├─ Tool definitions        ~10-20K  (含 MCP)
├─ User context (CLAUDE.md, git status...)
├─ Output reservation      默认 8K，必要时升 64K
└─ Conversation history    (剩余空间，持续增长)
```

常量：
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000`
- `WARNING_THRESHOLD_BUFFER_TOKENS = 20_000`
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（熔断器）

**槽位预留优化**：`maxOutputTokens` 默认从 32K 砍到 **8K**。API 按 `max_tokens` 预留推理槽容量，p99 实际输出只有 5K。砍到 8K 节省 8-16× 槽位，少于 1% 的请求被截断、自动升 64K 重试。

### Token 计数

- **粗估**：`chars / 4`（JSON `chars / 2`，图片固定 2000）— 每轮迭代的 `shouldAutoCompact` 检查用
- **精确**：`anthropic.beta.messages.countTokens` — 决策点用（压缩前后对比、warning）
- 3P provider（OpenAI/Gemini）无精确计数，退到粗估

### CompactBoundary 标记

压缩后插入 `SystemCompactBoundaryMessage`。后续 `getMessagesAfterCompactBoundary()` 切到最后的 boundary。元数据含 `compactType`、`preCompactTokenCount`、`lastUserMessageUuid`、`preservedSegment`（哪些消息原样保留 vs 摘要）。`--resume` 靠它精准重建。

### System Prompt 是 `string[]` 不是 `string`

为了缓存分块。任何单字符变化（日期更新）都会让单 string prompt 整个缓存失效。

三阶段流水线：
1. `getSystemPrompt()` — 收集 static + dynamic 区块，插入 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记
2. `buildEffectiveSystemPrompt()` — 5 级优先级选择（Override > Coordinator > Agent > Custom > Default）
3. `buildSystemPromptBlocks()` — 切块挂 `cache_control`

**铁律**：任何 runtime bit（启用的工具列表、isNonInteractive 等）必须放 **boundary 后**，否则 2^N Blake2b 哈希变体会击穿缓存。

### CLAUDE.md 层级

```
~/.claude/CLAUDE.md             用户全局
└── /project/CLAUDE.md          项目根（团队共享）
      └── /project/src/CLAUDE.md 子目录（模块特定）
```

加载为 **user context**（包裹在第一条 user message 的 `<system-reminder>` 里），**不是 system prompt** — 保护前缀缓存。

### 记忆系统（与 CLAUDE.md 分离）

文件型，无向量数据库。路径 `~/.claude/projects/<sanitized-git-root>/memory/`。索引 `MEMORY.md` 每次会话加载（200 行 / 25KB 双重上限）。

4 种封闭分类：`user` / `feedback` / `project` / `reference`。每类有 `<when_to_save>` / `<how_to_use>` / `<body_structure>` 约束。

召回：轻量 Sonnet 侧查询从 manifest 选 ≤5 条，过滤 `recentTools` 和 `alreadySurfaced`。

漂移防御：明确的 prompt 段「Before recommending from memory」要求 AI 在引用前验证（grep / 检查文件存在）。

### EmaAgent 借鉴策略

| 项 | 策略 |
|---|---|
| 三层压缩 | **改造**。V1 做 MicroCompact + API summary 两层，Session Memory Compact 是 V2。 |
| `adjustIndexToPreserveAPIInvariants` | **采纳**。MemoryPlanner 切割时必须做这个，否则 400。 |
| 8K 槽位预留 | **采纳**。LlmRouter 默认 max_tokens 设小，截断时升级。 |
| 粗估 + 精确双轨 | **采纳**。但你们 V1 默认 1P+SF 兼容层，精确计数都可走 Anthropic API。 |
| CompactBoundary | **采纳**。`packages/session` 的 SessionStore 必须有 boundary 概念。 |
| System prompt 为 `string[]` | **采纳**。`packages/prompts` 的 `buildSystemPrompt` 必须返回数组。 |
| dynamic boundary 标记 | **采纳**。所有 runtime bit（emotion 状态、ACT 语法块）放 boundary 后。 |
| CLAUDE.md 作为 user context 注入 | **改造**。V1 你们用角色卡，但同样的原理：角色卡 = system prompt 的 static 区，emotion/stage 实时状态 = boundary 后的 dynamic 区。 |
| 记忆 4 类型 + 召回链 | **采纳**。已经在 `packages/memory` 设计中。 |
| 「before recommending from memory」漂移防御 | **采纳**。在 memory 系统 prompt 段加这个约束。 |

---

## 3. 工具系统

### Tool 接口结构（35+ 字段，但分组清晰）

**核心 4 个**：`name` / `description(input)` / `inputSchema` / `call(args, ctx, canUseTool, parentMessage, onProgress?)`

**注册元数据**：`aliases` / `searchHint`（3-10 词关键词匹配）/ `shouldDefer`（懒加载）/ `alwaysLoad`（永不延迟）/ `isEnabled()`

**安全标志**：`validateInput()` / `checkPermissions()` / `isReadOnly()` / `isDestructive()` / `isConcurrencySafe()` / `preparePermissionMatcher()` / `interruptBehavior: 'cancel' | 'block'`

**输出/渲染**：`maxResultSizeChars`（Bash 30K / Skill 100K / Read `Infinity`）/ `mapToolResultToToolResultBlockParam()` / `renderToolResultMessage()` / `backfillObservableInput()`

**上下文**：`prompt()`（每工具注入到 system prompt 的使用文档）/ `outputSchema` / `getPath()`（权限规则用）

### 并发模型

`isConcurrencySafe()` 只对只读操作返回 `true`。StreamingToolExecutor 并行执行 safe 工具，副作用工具串行。Bash 是否 safe 由 AST 分析具体命令决定（`cat`/`grep` 是 safe，`rm`/`git push` 不是）。

### 结果尺寸预算

`maxResultSizeChars` 是硬上限，超限结果由 `applyToolResultBudget()` 落盘，AI 只看到预览 + 文件路径。Read 单独设 `Infinity`，否则 Read→file→Read 死循环。

### 内置工具分类

| 类 | 工具 |
|---|---|
| 文件 | Read（多格式：text/image/PDF/notebook，按 mtime+offset/limit 去重）/ Edit（原子读改写，引号归一化）/ Write（永远 LF 换行）/ Glob / Grep（ripgrep，默认 head_limit 250 ≈ 12-25K tokens）/ NotebookEdit |
| Shell | Bash（tree-sitter AST，4 命令集划分 search/read/list/semantic-neutral，默认超时 120s 最大 600s，15s 后自动后台）/ PowerShell |
| Agent | AgentTool / SendMessage / AskUserQuestion / TaskCreate-Update-List-Get-Output-Stop |
| Web | WebFetch（Turndown 转 Markdown，100K cap，黑名单，pre-approved 跳过 Haiku 总结）/ WebSearch（adapter：API/Bing/Brave） |
| 规划 | EnterPlanMode / ExitPlanModeV2（带 `allowedPrompts`）/ TodoWrite / Worktree / ToolSearch |
| 调度 | CronCreate/Delete/List |
| 扩展 | SkillTool / MCPTool / McpAuthTool |

### MCP 工具的差异

- 用 `inputJSONSchema`（原始 JSON Schema）而不是 Zod — schema 在远程
- 标记 `mcpInfo: { serverName, toolName }`
- Wire name：`mcp__<serverName>__<toolName>`
- 默认权限行为：`passthrough`（一律走权限提示）
- MCP annotation → Tool 字段：`readOnlyHint → isReadOnly && isConcurrencySafe`、`destructiveHint → isDestructive`

### 为什么要专用工具而不是通用 Bash

```
Read("foo.ts")            自动放行（只读）
Bash("cat foo.ts")         需要确认（Bash 是通用工具）
```

理由：权限粒度（精确工具名匹配 vs AST 解析）、结构化输出（可渲染 diff/高亮）、缓存、并发安全标记、审计清晰。

### EmaAgent 借鉴策略

| 项 | 策略 |
|---|---|
| 35 字段 Tool 接口 | **改造**。V1 抽 12-15 个核心字段（前面对话已经讨论过），其余 P1 加。 |
| `isReadOnly / isConcurrencySafe / isDestructive` 三个并存 | **采纳**。这是 PermissionEngine 风险分级的数据源，必须留。 |
| `maxResultSizeChars` 超限落盘 | **采纳**。`packages/sandbox` 提供工作区落盘接口。 |
| Read 用 `Infinity` 防循环 | **采纳**。 |
| `getPath()` 给权限规则用 | **采纳**。文件类工具必须实现。 |
| `searchHint` + `shouldDefer` + `alwaysLoad` | **跳过**。V1 工具数 <30，全量加载没问题。当工具数 >50 再加 ToolSearch 机制。 |
| `backfillObservableInput` | **改造**。V1 不需要观察者注入字段，先省略。 |
| MCP `inputJSONSchema` | **采纳**。V2 接 MCP 时必须。 |
| 专用工具优先于 Bash | **采纳**。Bash 是最后手段，能用 Read/Edit/Glob/Grep 就别上 Bash。 |

---

## 4. 权限与沙箱

### 三种行为

`allow` / `ask` / `deny` — 所有权限判断都返回 `PermissionResult`。

### 8 个规则来源（优先级低 → 高）

```
1. userSettings         ~/.claude/settings.json
2. projectSettings      .claude/settings.json (团队共享)
3. localSettings        .claude/settings.local.json (gitignored)
4. flagSettings         --settings CLI arg
5. policySettings       企业级 (用户不能覆盖)
6. cliArg               --allow / --deny
7. command              Skill 的 allowedTools
8. session              用户在对话框点「Always allow」
```

每个来源有 `alwaysAllowRules / alwaysAskRules / alwaysDenyRules` 三个数组。

### 三维度匹配

1. **工具名**：`Bash` / `mcp__server1` / `mcp__server1__*`（通配符）
2. **命令模式**（仅 Bash）：`"git *"` 匹配 `git commit -m '...'`。tree-sitter AST 抽取子命令，复合命令 `ls && git push` 拆成 `["ls", "git push"]` 独立检查
3. **路径**（文件工具）：`"src/**"` 对 `getPath(input)` 做 glob 匹配

### 5 级权限流水线

```
1a. getDenyRuleForTool()     — 工具名黑名单 → deny
1b. toolAlwaysAllowedRule()  — 工具名白名单 → allow
2.  tool.checkPermissions()  — 工具特定逻辑
3.  PreToolUse hooks         — 可覆盖判定
4.  getAskRules()            — ask 规则
5.  permissionMode 默认值    — default / plan / auto / bypassPermissions
```

### 拒绝追踪（防循环）

`DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`。连续 3 次同工具被拒 → `shouldFallbackToPrompting()` 返回 true → 注入「Your previous tool call was rejected, change strategy...」逼 AI 换路径。

### 沙箱（第二层，OS 级）

**与权限系统分离**。

- 权限说「该不该跑」
- 沙箱说「就算跑了能碰啥」

平台后端：
- macOS：`sandbox-exec`（Seatbelt profile）
- Linux/WSL2：`bubblewrap + seccomp`
- Windows 原生：**不支持**

什么进沙箱：BashTool 默认 / Linux/macOS/WSL 上的 PowerShell / Hook 命令（网络限制版）。

什么不进：FileEdit、FileWrite（直接走应用层 FS，权限系统管）。

默认沙箱配置由权限规则派生：
- `allowWrite`：CWD + Claude temp dir
- 额外写：`Edit(path)` 规则 + `--add-dir` + worktree
- 强制 deny：`settings.json`、`.claude/skills`、bare-git-repo 逃逸点
- 网络白名单：`WebFetch(domain:...)` 规则 + 显式 allowedDomains

`autoAllowBashIfSandboxed` 是核心权衡：「OS 沙箱已经兜底，低风险 shell 命令不需要再 prompt」。

### EmaAgent 借鉴策略

| 项 | 策略 |
|---|---|
| 3 行为 × 3 维度匹配 | **采纳**。`PermissionEngine` 必须支持工具名 + 路径 + 命令模式。 |
| 8 来源 | **改造**。V1 简化为 4 个：globalSettings / projectSettings / sessionGrant / cliArg。 |
| 5 级流水线 | **采纳**。是 `PermissionEngine.gate()` 的算法骨架。 |
| 连续拒绝 → fallbackToPrompting | **采纳**。直接复用你 v0.4 的 `repeated_error_guard` 思路扩展。 |
| OS 沙箱（sandbox-exec / bubblewrap） | **跳过**。V1 桌宠场景不接 prod 命令执行，工作区边界检查（WorkspaceScope）够用。V2 想接 agent 模式跑用户系统命令时再加。 |
| Windows 不支持沙箱 | **接受**。你们主目标 Windows + macOS，Windows 用户只能靠权限系统。 |
| `autoAllowBashIfSandboxed` | **跳过**。没有沙箱就没有这个优化。 |
| 权限规则可持久化（「Always allow」回写 settings.local.json） | **采纳**。是产品级 UX 的关键。 |

---

## 5. Hooks

### 27 个 hook 事件（生命周期全覆盖）

| 阶段 | 事件 |
|---|---|
| Session | SessionStart / SessionEnd / Setup |
| User | UserPromptSubmit / Stop / StopFailure |
| Tool | PreToolUse / PostToolUse / PostToolUseFailure |
| Permission | PermissionRequest / PermissionDenied |
| Subagent | SubagentStart / SubagentStop |
| Compact | PreCompact / PostCompact |
| Collab | TeammateIdle / TaskCreated / TaskCompleted |
| MCP | Elicitation / ElicitationResult |
| Env | ConfigChange / CwdChanged / FileChanged / InstructionsLoaded / WorktreeCreate / WorktreeRemove |
| Other | Notification |

### 6 种 hook 类型

- `command`（shell，stdin/stdout JSON）
- `prompt`（注入 AI 上下文）
- `agent`（派生子 agent）
- `http`（远程 webhook）
- `callback`（内部 JS 函数）
- `function`（运行时注册）

### Hook 输出 JSON 协议

```json
{
  "continue": false,
  "stopReason": "...",
  "decision": "approve" | "block",
  "hookSpecificOutput": {
    "permissionDecision": "allow" | "ask" | "deny",
    "updatedInput": { /* 修改工具参数 */ },
    "additionalContext": "..."
  }
}
```

**关键能力**：PreToolUse hook 的 `updatedInput` 可以**修改即将执行的工具参数**（例如自动给 test 命令加 `--bail`）。

### 异步 hook

stdout 第一行是 `{"async":true}` → 注册为 pending，后台跑，完成时通知主线程。exit code 2 + asyncRewake 模式 → 唤醒空闲模型注入 `task-notification`。

### 信任门

`shouldSkipHookDueToTrust()` — 交互式会话**必须先接受 workspace trust** 才能执行 hook。防御 clone 来的恶意 `.claude/settings.json`。

### 实际用途

- 阻止危险工具（PreToolUse → deny）
- 修改工具输入（PreToolUse → updatedInput）
- 审计日志（PostToolUse）
- CI/审批集成（TaskCompleted → 外部系统）
- 注入上下文（UserPromptSubmit → 编码规范）
- 过滤 MCP 输出（PostToolUse → updatedMCPToolOutput 抹掉秘钥）

### EmaAgent 借鉴策略

你的 `packages/hook` 已经有了 HookBus 骨架。对比之下：

| 项 | 你的现状 | 策略 |
|---|---|---|
| 事件清单 | 12 个 | **采纳扩充**。补 PermissionRequest / PermissionDenied / FileChanged / TaskCreated。Skills 相关的 V2 再说。 |
| `updatedInput` 修改工具参数 | 未实现 | **采纳**。`beforeToolUse` 的 `HookResult.replace` 已支持，但需要扩展 schema 让 hook 改 `args`。 |
| hook 类型多样性 | 只支持 callback | **改造**。V1 加 `command` 和 `prompt` 两种，其他先不做。 |
| 信任门 | 未实现 | **采纳**。Tauri 启动时一次性确认 workspace 信任。 |
| 异步 hook | 未实现 | **跳过**。V1 单用户单会话场景不需要。 |

---

## 6. Skills

### 与 Tools 的本质区别

| | Tool | Skill |
|---|---|---|
| 粒度 | 原子操作 | 完整工作流 |
| 触发 | AI 自主选择 | 用户 `/skill-name` 或 AI 通过 SkillTool |
| 本质 | TypeScript 代码 | **Prompt + 权限配置**（声明式） |
| 注册 | `getTools()` | `getCommands()` |
| 执行 | 工具的 `call()` | `SkillTool.call()` → inline 或 fork |

**核心洞察**：「复杂任务的关键不在代码逻辑，在 Prompt 质量。」一个 code-review skill 不需要审查引擎，只需要告诉 AI：看什么、按什么顺序、用什么格式输出。

### 5 个来源

1. **Built-in commands** — `src/commands.ts` 硬编码（~70+）
2. **Bundled skills** — 编译时 `registerBundledSkill()`，懒解压（防符号链接攻击 `O_NOFOLLOW | O_EXCL`），免 prompt 预算截断
3. **Disk skills** — `.claude/skills/<name>/SKILL.md`（仅目录格式）
4. **MCP skills** — server prompts 转 Command，**禁止 inline shell 执行**（远程不可信）
5. **Legacy commands** — `/commands/` 目录（兼容老格式）

### Frontmatter（16 字段）

```yaml
name: ...
description: ...
when_to_use: ...
allowed-tools: [...]
argument-hint: ...
arguments: [...]
model: opus | sonnet | haiku
effort: low | medium | high
context: inline | fork    # 关键：决定执行模式
agent: ...                # 用哪个子 agent
user-invocable: true
disable-model-invocation: false
version: ...
paths: [...]              # 条件激活：仅当操作文件路径匹配时可见
hooks: [...]
shell: bash | pwsh
```

### Inline vs Fork

- **Inline**（默认）：skill prompt 作为 `UserMessage` 注入主流程，返回 `contextModifier` 合并 `allowedTools` 到 `alwaysAllowRules.command`
- **Fork**（`context: fork`）：独立子 agent，隔离 token 预算，结果文本提取后释放子 agent 完整消息列表

### 安全属性白名单

5 层检查：deny → 远程经典 skill 自动放行 → allow → **Safe Properties whitelist**（30 个允许的 frontmatter 字段）→ ask（默认）。

任何不在白名单的字段会强制进入 ask 流程。新增字段默认需要权限。**正向安全设计**。

### Prompt 预算（上下文窗口的 1%，约 8K 字符）

三档降级：完整描述 → bundled 完整 + 非 bundled 截断到 250 字符 → 非 bundled 只剩名字。

### EmaAgent 借鉴策略

V1 暂时**跳过 Skills 系统**。理由：

1. V1 是单角色桌宠 + 3 模式，工作流相对固定，没必要做声明式 skill
2. Skills 真正发挥价值是「让用户自定义复杂工作流」，V1 不开放这个
3. V1 类似的需求由「角色卡」承担——角色卡本质就是一个 skill（声明式 prompt + 模块绑定）

V2 引入 Skills 时可以采纳：声明式 frontmatter / inline vs fork 执行模式 / 安全属性白名单。

---

## 7. Sub-agents & Coordinators

### 3 种 sub-agent 路径

| | Named Agent | Fork subagent | General-purpose |
|---|---|---|---|
| 触发 | `subagent_type` 指定 | Fork enabled + type 省略 | Fork disabled + type 省略 |
| System prompt | agent 自己的 | 继承父的完整 SP | general-purpose SP |
| 工具池 | `assembleToolPool()` 独立 | 父的工具完整复用 | 独立 |
| 上下文 | 只有 task description | 父的完整对话（forkContextMessages） | 只有 task |
| 模型 | 独立 | 继承父 | 独立 |
| 权限模式 | agent 自己的 | `'bubble'` 到父终端 | agent 自己的 |
| 目的 | 特化委派 | **prompt 缓存命中率** | 一般工作 |

### Fork 机制（缓存共享优化）

所有 fork 子 agent 共享父的**完整** assistant 消息（每个 tool_use block），全部填占位符 `FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'`。只有最后一个 text block 不同（子 agent 的具体指令）。

这让 API 请求的前缀字节在所有 fork 间一致 → 最大化缓存命中。

### Worktree 隔离

`isolation: "worktree"` 在 `<repo>/.claude/worktrees/<slug>/` 创建独立 git worktree，分支 `worktree/<slug>`。slug 校验：每段 alphanumeric + `.`/`_`/`-`，总长 ≤64。

退出策略：
- `keep` → chdir 回去，清 session
- `remove` → **fail-closed 安全**：`countWorktreeChanges()` 任何 git 失败返回 `null` → 拒绝删除。未追踪变更需 `discard_changes: true`。`call()` 时重新计数（处理 validateInput→call 竞态）。

### Coordinator 模式（星型，集中式）

Coordinator 在中心，workers 在边缘。Coordinator 只有 `Agent` / `SendMessage` / `TaskStop` / `subscribe_pr_activity` — 不读、不写、不执行，只编排。

**严格设计约束**（写在 system prompt 里）：「Coordinator 必须先理解再委派」。「Based on your findings, fix X」是显式反模式，正确做法是「Fix the null pointer in src/auth/validate.ts:42 [具体上下文]」。

### Agent Swarms（星型 + P2P 混合）

Team Lead 协调；teammates 可通过 Mailbox 互相通信（定向 `message` 或 `broadcast`）。共享任务列表，竞争性认领（lockfile）。

### EmaAgent 借鉴策略

| 项 | 策略 |
|---|---|
| Named Agent（独立 system prompt 和工具池） | **采纳**。V1 的 `apps/desktop` 桌宠就是 Ema 这一个 named agent。 |
| Fork subagent（共享父上下文） | **跳过**。V1 没多 agent 协作场景。 |
| Worktree 隔离 | **跳过**。EmaAgent 不是 dev tool，不需要 git worktree。 |
| Coordinator Mode | **跳过**。V1 单 agent。 |
| Swarms / Mailbox | **跳过**。V1 单 agent。 |
| 「先理解再委派」原则 | **采纳为编码规则**。V2 引入 subagent 时写进 prompt。 |

但 CLAUDE.md 现有规划里写了「subagent tool 接口已留」（P2 第 17 项），这个**接口预留**是对的：先把 `subagent` 当成一种 tool 类型放进 ToolRegistry，但 V1 不实际实现。

---

## 8. AgentPolicy（Plan / Auto 两种自治策略）

### Plan Mode — 只读强制

两工具闭环：
1. **EnterPlanModeTool** — 需用户批准。`handlePlanModeTransition()` 存原 mode，`prepareContextForPlanMode()` 创建只读上下文。在 plan mode 下，`tool.isReadOnly()` 是**唯一**的权限闸门。
2. AI 用只读工具（Read/Grep/Glob/Agent）探索。
3. **ExitPlanModeV2Tool** — 提交计划文件等用户审批。两个关键效果：
   - 恢复原 permission mode
   - **基于 prompt 的权限注入**：计划可声明 `allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }, ...]` — 语义化权限，用户在退出时一次性批准，执行期间匹配命令不需要逐次确认

Plan 持久化到磁盘，用户**可编辑**计划再批准（`planWasEdited` flag）。

### Auto Mode — 分类器驱动

把「每次问用户」换成「每次问 AI 分类器」。

架构：
- `yoloClassifier` — 每次工具调用得到 `allow | deny | ask`
- **两阶段管线**（`classifyYoloActionXml`）：
  - 第 1 阶段「fast」：`max_tokens=64`，stop_sequences，立即 yes/no
  - 第 2 阶段「thinking」：CoT 推理（仅 Stage 1 block 时进入）
  - 两阶段共享 system prompt + user content → 命中 prompt cache（1h TTL）

### Auto-mode 安全：危险规则剥离

进入 auto mode 时 `stripDangerousPermissionsForAutoMode()` 移除：
- Bash 代码执行：`Bash(python:*)` / `Bash(node:*)` / `Bash(bash:*)` / `Bash(sh:*)`
- `Agent(*)`（任何 Agent 通配放行会让 spawn 出来的 agent 绕过分类器）
- PowerShell 等价物
- 提权：`Bash(sudo:*)` / `Bash(eval:*)`

剥离的规则存 `strippedDangerousRules`，退出时恢复。

**理由**：「allow python:*」让 AI 任意执行代码，完全绕过分类器对**代码内容**的审查。

### Auto-mode prompts（值得抄）

进入时（核心几句）：
- "Execute immediately"
- "Minimize interruptions"
- "Prefer action over planning"
- "Expect course corrections"
- "Do not take overly destructive actions"（删除/生产仍要问）
- "Avoid data exfiltration"

退出时：「Ask clarifying questions when ambiguous rather than making assumptions.」

### 三种模式的心智模型（最重要）

- **default** = 「每个敏感操作都问用户」 — 交互式，低自治
- **plan** = 「AI 必须先思考再行动」 — 时序分离：只读探索 → 可审计计划 → 带预批准的执行
- **auto** = 「AI 用分类器自我审查」 — 持续自治 + 分类器把关 + 危险规则预剥离

每种处理一种不同的失败模式：default 处理「AI 可能判断错」；plan 处理「AI 可能莽撞」；auto 处理「用户被弹窗疲劳」。

### EmaAgent 借鉴策略

你 CLAUDE.md 已经声明了 `plan / debug / full` 三档 AgentPolicy。映射建议：

| EmaAgent 模式 | 对应 claude-code | 实现策略 |
|---|---|---|
| `plan` | Plan Mode | **完全采纳**。只允许 `isReadOnly()` 工具，maxTurns 低，每步审批。 |
| `debug` | 介于 default 和 plan 之间 | 允许读 + 受控写（Edit），不允许 Bash/Shell；自动执行；中等 maxTurns。 |
| `full` | default + 可选 auto | 全工具；权限模式由用户在 UI 选 default/auto；高 maxTurns。 |

**Plan 模式必须采纳的关键设计**：
1. `isReadOnly()` 作为唯一闸门（实现简单且安全）
2. Plan 文件落盘 + 用户可编辑后批准
3. `allowedPrompts` 语义化预批准（V2 加）

**Auto 模式 V1 跳过**：

1. 分类器需要额外 LLM 调用，提高成本
2. 桌宠场景用户在场，弹窗不算疲劳
3. V2 接 agent 长任务时再加

---

## 9. MCP 集成

### 两种模式

- **内置 MCP**：同进程，零开销（`InProcessTransport`）。自动注册为 `dynamic` scope。`allowedTools` 列表自动放行。
- **外部 MCP**：用户配置，7 种传输：stdio（默认）/ sse / http / ws / sse-ide / ws-ide / claudeai-proxy。

### 配置 schema

```json
{
  "mcpServers": {
    "my-db": {
      "command": "npx",
      "args": ["@my-org/mcp-server"],
      "env": { "API_KEY": "$ENV_VAR" }
    },
    "remote": {
      "type": "http",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." },
      "oauth": { "clientId": "...", "authServerMetadataUrl": "..." }
    }
  }
}
```

### 8 个配置来源（优先级）

claude.ai connectors < plugins < user settings < project（`.mcp.json`，需批准）< local < dynamic（内置）。

企业 `managed-mcp.json` → **独占模式**：忽略所有其他来源。

### 连接生命周期

`connectToServer()` 用 `memoize` by `${name}-${JSON.stringify(config)}` 缓存。`client.onclose` 清缓存，下次访问触发重连。

stdio 清理用信号递增：`SIGINT (100ms) → SIGTERM (400ms) → SIGKILL`，总封顶 600ms。

### 工具发现

`fetchToolsForClient()` 用 `memoizeWithLRU(100)`。Wire name `mcp__<server>__<tool>`。描述上限 2048 字符（防御真实 MCP server 发 15-60KB 描述）。

### 并发

本地：`getMcpServerConnectionBatchSize() = 3`（子进程重）  
远程：`getRemoteMcpServerConnectionBatchSize() = 20`（HTTP 轻）

### EmaAgent 借鉴策略

V1 **不接入 MCP**（CLAUDE.md 没列在 P0/P1）。V2 接入时建议：

1. 先支持 stdio + http 两种传输（覆盖 90% 场景）
2. 配置 schema 直接复用 claude-code 的（社区已有 MCP server 都按这个格式）
3. 连接缓存 + LRU 工具缓存必做
4. Description 截断 2048 必做
5. Wire name 用 `mcp__<server>__<tool>` 保持兼容

---

## 10. 给 EmaAgent 的 12 条横切设计原则

通读后归纳出来的可执行原则，每条都对应一个具体设计动作：

1. **Loop transition 命名化** — 不要写 `if (...) continue`；写 `state.transition = 'max_output_recovery'; continue;`
2. **State 不可变重建** — `state = { ...oldState, messages: newMessages }` 每次 continue 创建新对象
3. **Compaction 是流水线** — micro / session-summary / api-summary 三层，不要塞进一个函数
4. **Tool flag 三件套永远存在** — `isReadOnly` / `isConcurrencySafe` / `isDestructive` 是 PermissionEngine 的数据源
5. **Tool result 超限落盘** — `maxResultSizeChars` 是硬约束，超限走 ArtifactStore
6. **System prompt 是 `string[]`** — boundary 之前是 cache 区，之后是 dynamic 区
7. **Runtime bit 永远在 boundary 后** — emotion / stage / 当前角色卡名都不能在 cache 区
8. **CLAUDE.md 类内容作为 user context** — 不要塞 system prompt
9. **权限规则三维度** — 工具名 × 模式（命令/路径）× 来源
10. **拒绝循环熔断** — 连续 N 次拒绝注入「change strategy」message
11. **Plan mode 用 `isReadOnly()` 单一闸门** — 简单到不容易出 bug
12. **CompactBoundary 是 turn 标记** — `--resume` 和增量召回都靠它

---

## 11. 显式跳过清单（不做的事）

为了不被 claude-code 的复杂度淹没，明确 V1 **不做**：

- ❌ OS 级沙箱（sandbox-exec / bubblewrap）— WorkspaceScope 路径检查足够
- ❌ Auto Mode 分类器 — 桌宠不需要分类器代替用户
- ❌ Fork subagent — 单 agent 不需要
- ❌ Coordinator / Swarm — 单 agent 不需要
- ❌ Worktree 隔离 — 不是 dev tool
- ❌ Skills 声明式工作流 — 角色卡承担类似职责
- ❌ MCP — V2 再说
- ❌ ToolSearch deferred-loading — 工具数 <30 全量加载
- ❌ Token Budget（USD 预算）feature — 个人单机不需要
- ❌ Hook 异步 / async-rewake — 单用户单会话不需要
- ❌ Sessions Memory Compact — V2 加，V1 只做 micro + api-summary
- ❌ 8 个权限规则来源 — V1 简化到 4 个

把这些显式跳过列出来，避免半年后翻 claude-code 文档时纠结「为什么我们没做这个」。

---

## 附：阅读源文档时的导航

如果以后还要回看 claude-code docs，按优先级：

- **必读**：`conversation/the-loop.mdx` / `context/compaction.mdx` / `safety/permission-model.mdx` / `safety/plan-mode.mdx` / `safety/auto-mode.mdx`
- **二级**：`tools/what-are-tools.mdx` / `context/system-prompt.mdx` / `extensibility/hooks.mdx` / `agent/sub-agents.mdx`
- **三级**：`tools/shell-execution.mdx`（Bash 设计很值得）/ `extensibility/skills.mdx` / `safety/sandbox.mdx`
- **不用看**：`features/` 下绝大部分（bridge / daemon / RCS / computer-use / langfuse / growthbook / LAN pipes / voice / chrome）— 与 EmaAgent 无关
