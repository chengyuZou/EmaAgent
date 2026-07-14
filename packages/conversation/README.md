# @ema-agent/conversation

> Chat / Narrative 回合引擎 —— 单次 LLM 调用的统一 turn 流，与 agent 包平行。
> 更新时间 2026-6-6

---

## 架构位置

```
apps/core (orchestrator)
  │
  ├─ turn mode = 'chat' | 'narrative' → ConversationEngine.run()
  ├─ turn mode = 'agent'               → AgentEngine.run()
  │
  └─ register-hooks.ts 统一装配所有 beforeLlm handler
        ├─ priority 5:  conversation/narrative:recall
        ├─ priority 10: prompts/buildSystem
        └─ priority 20: memory/beforeLlm
```

ConversationEngine **不 import AgentEngine，也不 import MemoryPlanner**。它只管触发事件、消费结果、流式输出。跨横切面的能力（记忆、提示词、叙事 RAG）全部通过 HookBus 注入。

---

## 文件

```
src/
├── index.ts       # 导出 ConversationEngine + registerConversationHooks + 类型
├── engine.ts      # 引擎核心：runTurn() 异步生成器 + streamingBeforeLlm 桥
├── hooks.ts       # 注册 narrative:recall hook（叙事模式 RAG 召回）
└── types.ts       # ConversationDeps, ConversationRunInput
```

---

## 一、`types.ts` —— 依赖与输入

### `ConversationDeps`

Engine 需要的最小依赖面，是 `AppBindings` 的严格子集——CLI 也能满足：

| 字段 | 类型 | 用途 |
|---|---|---|
| `session` | `SessionStore` | 加载历史、追加消息 |
| `hooks` | `HookBus` | 触发生命周期事件 |
| `llm` | `LlmRouter` | LLM 流式调用 |
| `emotion` | `EmotionEngine` | 流式情绪检测（ACT 标签解析） |
| `narrative` | `NarrativeClient` | 叙事桥客户端（仅 narrative:recall hook 使用） |
| `modelBindings` | `ModelBindingsRepo` | 按 mode 查找 provider/model 绑定 |

### `ConversationRunInput`

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn` | `Turn` | 调用方已通过 `session.startTurn()` 启动的回合 |
| `signal` | `AbortSignal` | 用户点击 Stop 时触发 |
| `sessionId` | `SessionId` | 当前会话 |
| `mode` | `'chat' \| 'narrative'` | Agent 模式由 AgentEngine 处理 |
| `userInput` | `string` | 用户文本输入 |
| `contentParts` | `LlmContentPart[]` | 多模态附件（可选，优先于 userInput） |
| `model` | `string` | 显式模型覆盖（可选） |

---

## 二、`engine.ts` —— 回合流

### 完整流程

```
ConversationEngine.run(input)
  │
  ├─ emotion.beginTurn()
  ├─ onTurnStart hook ──→ 权限/门禁，abort 则 failTurn
  │
  ├─ provider 解析           modelBindings.get(mode) → providerId + model
  ├─ 历史加载 + 用户消息持久化
  │
  ├─ beforeLlm hook (streamingBeforeLlm)
  │     ↑ 后台执行，事件即时穿透 SSE
  │     ↑ narrative:recall 在此注入叙事上下文
  │     ↑ memory:beforeLlm 在此注入记忆片段
  │
  ├─ LLM stream
  │     ├─ text_delta     → emotion.processChunk() → output_text_delta + 情绪事件
  │     ├─ thinking_delta → reasoning_delta（只给 UI 临时/历史展示）
  │     └─ usage/done     → 记录 token / 结束流
  │
  ├─ emotion.flush()       扫描残尾（模型可能在 ACT 标签中间停）
  ├─ afterLlmComplete hook
  ├─ 持久化 assistant 消息（text + thinking）+ afterMessage hook
  │
  └─ onTurnEnd hook → completeTurn → turn_completed

异常:
  ├─ signal.aborted && 流未完成 → onTurnAbort → abortTurn → turn_aborted
  └─ 其他错误                 → failTurn → turn_failed
```

### 关键设计

| 要点 | 说明 |
|---|---|
| `llmStreamDone` 标志 | 区分"用户中途停止"和"流结束后 hook 报错"。只有流未完成时 abort 才算用户主动停止。 |
| `yield* streamingBeforeLlm` | 见下方详解——这是整个引擎最精巧的部分。 |
| Thinking 处理 | `thinking_delta` 会 emit 为 `reasoning_delta`；provider 没有显式 `thinking_complete` 时，stream 正常结束会补发 `reasoning_complete`。持久化时保存 thinking/signature 供 UI 与调试使用，但 `historyToLlmMessages()` 不会把 thinking 回灌给下一次 LLM。 |
| Provider-safe replay | 历史回放只保留 system 文本、普通 user content parts、assistant text blocks；assistant thinking/tool_use 与 user tool_result 都不会进入 conversation 的下一次 LLM 调用。 |

---

### `streamingBeforeLlm` —— 异步生成器桥

```
  runTurn()                           streamingBeforeLlm()
  ────────                            ─────────────────────
                                       ┌─────────────────────────┐
  const result =                       │ const emit = (ev) => {  │
    yield* streamingBeforeLlm(         │   queue.push(ev);       │
      hooks, ctx                       │   notify?.();           │
    );                                 │ };                      │
       │                               │                         │
       │                               │ hooks.trigger(          │
       │  ┌─────────────────────────── │   'beforeLlm',          │
       │  │  后台 Promise ──────────── │   { ...ctx, emit }      │
       │  │  不阻塞 SSE 输出           │ ).then(                 │
       │  │                            │   (r) => { result=r;    │
       │  │  hook 里 emit() 事件       │            done=true }  │
       │  │       │                    │ );                      │
       │  │       ▼                    │                         │
       │  │    queue.push(ev)          │ while (!done || queue) {│
       │  │       │                    │   while (queue)         │
       │  │       │  唤醒              │     yield queue.shift() │
       │  │       └─────────────────── │   if (!done) await …    │
       │  │                            │ }                       │
       │  │                            │ return result;          │
       │  └─ 等 done，逐条 yield 事件 ─┘                         │
       ▼                              ─────────────────────────┘
  result = { kind: 'continue', payload: { messages } }
```

普通写法是 `await hooks.trigger()` → 等全部 handler 跑完 → 一次性拿到结果。但叙事模式需要**渐进式渲染**——timeline A 查完就显示，不等 B。

`streamingBeforeLlm` 解决了这个问题：`trigger()` 在后台 Promise 里跑，hook 通过 `ctx.emit()` 推送事件 → 事件入队 → `yield*` 逐条发射给外层 SSE → 前端即时看到进度。全部 handler 完成后，`trigger()` 的返回值作为生成器表达式的值赋给 `result`。

---

## 三、`hooks.ts` —— 叙事 RAG 召回

### 注册的 hook

| 事件 | 名称 | 优先级 | 生效条件 |
|---|---|---|---|
| `beforeLlm` | `narrative:recall` | 5 | `ctx.payload.mode === 'narrative'` |

### 执行流程

```
narrative:recall (beforeLlm, priority 5)
  │
  ├─ ctx.payload.mode !== 'narrative' → return continue（跳过）
  │
  ├─ await narrative.route(userInput)
  │     ctx.emit({ narrative_route_resolved, timelines })
  │
  ├─ Promise.allSettled([各 timeline 并行查询])
  │     ├─ timeline A: queryOne → ctx.emit({ narrative_timeline_complete, A })
  │     ├─ timeline B: queryOne → ctx.emit({ narrative_timeline_complete, B })
  │     └─ ...
  │
  ├─ one bad timeline → ctx.emit({ system_warning }) → 排除该条，继续
  ├─ bridge 全挂 → throw NarrativeUnavailableError → 外层 catch → fallback chat 模式
  │
  ├─ 按路由顺序排序 recallParts（Promise.allSettled 按完成顺序，需重排）
  └─ return { kind: 'replace',
       payload: { messages: [..., recallMsg, lastUserMsg] } }
       ↑ 叙事上下文作为 user 消息注入到最后一条用户消息之前
       ↑ 不碰 system prompt，保留 prompt-cache 复用
```

`ctx.emit` 是当前 turn 的共享 `EmaStreamEvent` 出口，不属于 conversation 独占。叙事召回只 emit contracts 中已有的 `narrative_route_resolved`、`narrative_timeline_complete` 和必要的 `system_warning`；不 emit 未命名空间的泛用 recall 事件，避免和 memory/知识库等其他 recall 域混淆。

---

## 四、与 agent 包的对比

| | conversation | agent |
|---|---|---|
| 模式 | chat / narrative | agent (full / plan / debug) |
| LLM 调用 | 单次 stream | 多轮 think→act loop |
| 工具执行 | 无 | TurnToolExecutor 并发执行 |
| 迭代上限 | 1 次 | 10 / 15 / 30 次 |
| blockIndex | 跟随 provider chunk；支持 text/thinking 交错，但不执行工具 | 多 block（text + thinking + tool_use 交错） |
| 共享的事件 | beforeLlm, afterLlmComplete, afterMessage, onTurnStart, onTurnEnd, onTurnAbort | 同左 |

两个引擎**完全独立**，互不 import，只是挂在同一套 HookBus 事件上。
