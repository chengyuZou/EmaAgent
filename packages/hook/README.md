# @ema-agent/hook

EmaAgent 的 Hook 事件总线。把角色卡注入 / 记忆召回 / TTS 触发 / 审计 / 指标等横切关注点挂到 engine 生命周期点,engine 主循环只 `trigger()`,不内置这些逻辑。

## 架构

```
engine ──trigger(event, ctx)──► HookBus ──按优先级串行/并行调度──► 各 handler
                                   │
                                   └── 返回 {kind: continue|abort, payload, warnings}
```

## 12 个事件

| 事件 | 类型 | 触发时机 |
|---|---|---|
| `beforeLlm` | 控制型(可 replace/abort) | 调 LLM 前 |
| `afterLlmComplete` | 观察型(并行) | LLM 返回后 |
| `afterAssistantMessage` | 观察型(并行) | assistant 消息持久化后 |
| `beforeToolUse` | 观察型(**串行**) | PermissionEngine 决策前 |
| `afterToolUse` | 观察型(并行) | 工具成功后 |
| `onToolFailure` | 观察型(并行) | 工具失败时 |
| `beforeCompact` | 控制型(仅 abort) | 上下文压缩前 |
| `afterCompact` | 观察型(并行) | 压缩后 |
| `onTurnStart` | 控制型(可 replace/abort) | Turn 开始 |
| `onTurnEnd` | 观察型(并行) | Turn 正常结束 |
| `onTurnAbort` | 观察型(并行) | Turn 被中止 |
| `onTurnFailure` | 观察型(并行) | Turn 失败 |

- **控制型 3 个**:`beforeLlm` / `beforeCompact` / `onTurnStart`--可改控制流。`beforeLlm`/`onTurnStart` 可 `replace` payload;`beforeCompact` 只能 `abort`
- **观察型 9 个**:只能 `continue`。工具生命周期事件刻意识观察型--工具安全由 `PermissionEngine` + `Sandbox` 负责,Hook 不拦截/授权/改参
- **不进 HookBus 的 2 个 app 级事件**:`onCharacterCardSwitch` / `onEmotionChange`--直接发 `character_card_switched` / `emotion_changed` EmaStreamEvent,绕过优先级排序

## 关键机制

- **优先级**:5 档 `PRIORITY`(`FIRST:10` / `EARLY:20` / `NORMAL:50` / `DEFAULT:100` / `LATE:200`),数字越小越先执行;同档保持注册顺序。自定义数字可插入档位之间
- **批次**:`buildBatches` 把按优先级排序的 handler 分串行批/并行批。连续的 `parallel: true` 且事件支持并行 -> 合并为一个并行批;串行 handler 各成一批
- **并发**:`maxConcurrency`(默认 8)限并行批内并发,超了分块串行
- **payload 隔离**:`immutableHookPayload` 给每个 handler 深克隆 + 冻结的 payload 副本(`structuredClone` 优先,手写递归兜底),防互改;`replace` 返回值再克隆(去冻结)成新 `currentPayload`
- **取消/超时**:`createHandlerAbortScope` 把父任务取消 + handler 超时汇到一个 `AbortController`,`Promise.race([handler, interruption])` 竞速。`HookCancelledError`(父取消)/`HookTimeoutError`(超时)经 `classifyHookFailure` 归到稳定 `failureKind`
- **错误隔离**:`critical: true`(默认)抛错中止链;`critical: false` 抛错记 `HookWarning` 并继续。观察型非法返回 `replace`/`abort` 记 `protocol_violation` warning 并继续
- **trace**:`traceSink(entry)` 每次 handler 执行后回调(含 `invocationId`/`durationMs`/`result`/`failureKind`),供诊断层。`hook_warning` SSE 旁路上报

## Facade

| Facade | 职责 |
|---|---|
| `HookBus` | `register(event, handler, opts)` / `trigger(event, ctx)` / `list(event?)` |
| `PRIORITY` | 5 档优先级常量 |

## 文件

| 文件 | 职责 |
|---|---|
| `bus.ts` | HookBus 核心:register / trigger / runOne / runParallelBatch / buildBatches |
| `events.ts` | 12 个 HookEvent + Control/Observer/AbortOnly 分类 + 各事件 payload 类型 |
| `types.ts` | HookContext / HookResult / HookOptions / HookTraceEntry 等公共类型 |
| `priority.ts` | 5 档 `PRIORITY` 常量 |
| `payload-snapshot.ts` | `cloneHookPayload` / `immutableHookPayload`(深克隆 + 冻结) |
| `errors.ts` | `HookConfigurationError` / `HookTimeoutError` / `HookCancelledError` + `classifyHookFailure` |

## 不做

- 不含业务逻辑(不调 LLM / 不存 DB / 不知道角色卡是什么)
- 不做权限拦截 / 参数改写 / 沙箱隔离(工具安全由 `PermissionEngine` + `Sandbox` 负责)
- 不做流式 delta 消费(TTS 等长生命周期 sidecar 由 orchestrator 直接订阅 engine event stream)
