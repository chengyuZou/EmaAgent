# @ema-agent/session

会话生命周期、并发控制、持久化读写的领域核心。不负责 mode 编排、prompt 组装、LLM 调用、SSE 转换。

---

## 文件地图

| 文件 | 职责 | 产出物 |
|------|------|--------|
| `session-manager.ts` | Façade：组合 ActiveSession + TurnLock + SessionWriter 为统一入口 | `SessionManager` |
| `session-writer.ts` | 纯 DB 写入：创建/删除 session，落盘 turn 状态，写入/upsert 消息，更新标题 | `SessionWriter` |
| `session-reader.ts` | 纯 DB 只读：会话列表、详情聚合、历史消息分页 | `SessionReader` |
| `active-session.ts` | 进程内内存态：currentTurn、AbortController、生命周期事件订阅 | `ActiveSession` |
| `turn-lock.ts` | Turn 并发锁：同 session 同时最多一个 running turn | `acquireTurnLock` |
| `index.ts` | barrel 统一导出 | — |

---

## 核心设计

### 1. 组合而非上帝类

- `ActiveSession` 是纯内存状态机，**不碰数据库**。
- `SessionWriter` 是纯 DB 写映射，**不管内存**。
- `SessionManager` 组合两者，用 try/catch 确保 DB 写失败时回滚内存态。
- `SessionReader` 是独立只读通道，不依赖 ActiveSession。

### 2. 按需加载

仅在用户打开 Session 或发起 Turn 时才实例化 `ActiveSession` 放入 `activeSessions` 映射。长时间闲置由 `unloadSession()` 清理。

### 3. 内存态不进协议包

`AbortController` 不可 JSON 序列化，`currentTurn` 是进程内临时状态。绝对禁止将此类对象定义在 `@ema-agent/core-types`。

---

## 完整流转

```
上层 (turn-service / orchestrator)
  │
  ├─ ensureSession(sessionId)
  │    → SessionWriter.createSession 或 no-op（已存在）
  │
  ├─ beginTurn({ sessionId, requestId, mode, userInputBlocks })
  │    ├─ ActiveSession.beginTurnInMemory  → 创建 AbortController + currentTurn
  │    ├─ SessionWriter.markTurnQueued     → turns 表: status = "queued"
  │    ├─ SessionWriter.appendUserMessage  → messages 表: user ChatMessage
  │    ├─ SessionWriter.appendAssistantMessageShell → messages 表: assistant 空壳（status = "generating"）
  │    └─ SessionWriter.markTurnRunning    → turns 表: status = "running"
  │    └─ 返回 { turnRecord, abortSignal, userMessageId, assistantMessageId }
  │
  ├─ [SSE 流式循环]
  │    └─ SessionWriter.upsertAssistantMessage → contentBlocks 增量落盘
  │
  ├─ completeTurn({ sessionId, requestId, usage })
  │    ├─ SessionWriter.markTurnCompleted  → turns 表: status = "completed"
  │    └─ ActiveSession.completeTurnInMemory
  │
  └─ failTurn({ sessionId, requestId, error })
       ├─ SessionWriter.markTurnFailed     → turns 表: status = "failed"
       └─ ActiveSession.failTurnInMemory
```

---

## 导出的核心 API

### SessionManager（Façade）

```typescript
export class SessionManager {
  constructor(storage: SqliteStorage)

  /** 确保 session 存在——不存在则创建，返回是否新建。 */
  ensureSession(sessionId: SessionId, opts?: {
    title?: string
    mode?: EmaMode
  }): Promise<EnsureSessionResult>

  /** 开始一个 Turn：获取锁 → 内存注册 → 落盘 queued → 写 user 消息 → 写 assistant 空壳 → 标 running。 */
  beginTurn(input: BeginTurnInput): Promise<BeginTurnResult>

  /** 正常完成 Turn。 */
  completeTurn(input: CompleteTurnInput): Promise<void>

  /** Turn 执行失败。 */
  failTurn(input: FailTurnInput): Promise<void>

  /** 用户主动打断当前 Turn。 */
  abortTurn(sessionId: SessionId): void

  /** 卸载闲置 session 的内存态。 */
  unloadSession(sessionId: SessionId): void
}

export interface BeginTurnInput {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode
  /** 用户原始输入块——SessionManager 内部构建 ChatMessage。 */
  userInputBlocks: TurnInputBlock[]
  lockStrategy?: TurnLockStrategy  // 默认 "abort-previous"
}

export interface BeginTurnResult {
  turn: TurnRecord
  abortSignal: AbortSignal
  userMessageId: MessageId
  assistantMessageId: MessageId
}

export interface CompleteTurnInput {
  sessionId: SessionId
  requestId: RequestId
  usage?: UsageView
}

export interface FailTurnInput {
  sessionId: SessionId
  requestId: RequestId
  error: EmaError
}

export interface EnsureSessionResult {
  created: boolean
}
```

### SessionWriter（纯 DB 写入）

```typescript
export class SessionWriter {
  constructor(storage: SqliteStorage)

  createSession(input: CreateSessionInput): Promise<SessionState>
  deleteSession(sessionId: SessionId): Promise<void>

  markTurnQueued(input: MarkTurnInput): Promise<TurnRecord>
  markTurnRunning(input: MarkTurnInput): Promise<void>
  markTurnCompleted(input: MarkTurnCompletedInput): Promise<void>
  markTurnFailed(input: MarkTurnFailedInput): Promise<void>
  markTurnAborted(input: MarkTurnAbortedInput): Promise<void>

  appendUserMessage(sessionId: SessionId, message: ChatMessage): Promise<void>
  /** 写 assistant 消息空壳（contentBlocks: [], status: "generating"）——beginTurn 时调用。 */
  appendAssistantMessageShell(sessionId: SessionId, message: ChatMessage): Promise<void>
  upsertAssistantMessage(sessionId: SessionId, message: ChatMessage): Promise<void>

  updateTitle(sessionId: SessionId, title: string, status?: SessionTitleStatus): Promise<void>
}
```

### SessionReader（纯 DB 只读）

```typescript
export class SessionReader {
  constructor(storage: SqliteStorage)

  listSessions(): Promise<SessionSummary[]>
  loadSessionDetail(sessionId: SessionId): Promise<SessionDetailView | null>
  loadSessionHistory(input: LoadSessionHistoryInput): Promise<MessagePage>
}
```

### TurnLock（纯函数）

```typescript
export type TurnLockStrategy = "reject" | "abort-previous"

export interface TurnLockResult {
  allowed: boolean
  reason?: "turn_in_progress"
  abortedRequestId?: RequestId
}

export function acquireTurnLock(
  activeSession: ActiveSession,
  newRequestId: RequestId,
  strategy: TurnLockStrategy,
): TurnLockResult
```

### ActiveSession（内存态）

```typescript
export interface ActiveTurn {
  requestId: RequestId
  sessionId: SessionId
  mode: EmaMode
  startedAt: UnixMs
  status: TurnStatus
  error?: EmaError
  abortController: AbortController
}

export class ActiveSession {
  constructor(sessionId: SessionId)

  getCurrentTurn(): ActiveTurn | null
  isIdle(): boolean

  beginTurnInMemory(requestId: RequestId, mode: EmaMode): ActiveTurn
  completeTurnInMemory(requestId: RequestId): void
  failTurnInMemory(requestId: RequestId, error: EmaError): void
  abortCurrentTurn(reason?: string): void

  subscribe(callback: SessionEventCallback): UnsubscribeFn
  publish(event: SessionLifecycleEvent): void
}
```

---

## Turn 状态机

```
queued → running → completed
              ↘ failed
              ↘ cancelled (aborted)
```

- `markTurnQueued` 写 `status = "queued"`
- `beginTurn` 在完成用户消息 + assistant 空壳落盘后，调用 `markTurnRunning` 推进到 `"running"`
- 区分 `queued` 和 `running` 的目的：前端可根据 `queued` 状态显示"排队中"动画，`running` 后切换为"思考中"

---

## 依赖

- `@ema-agent/core-types` — 实体类型（`SessionState`、`TurnRecord`、`ChatMessage`、`EmaError` 等）
- `@ema-agent/constants-core` — 运行时常量（`SESSION_TITLE_MAX_LENGTH`、`TITLE_TRUNCATION_SUFFIX`）
- `@ema-agent/storage-sql` — 数据访问（只通过 `SqliteStorage` 接口注入）

## 不做什么

- 不负责 mode 编排、prompt 组装 — 属于 orchestrator
- 不调用 LLM — 属于 `@ema-agent/llm`
- 不转换 SSE — 属于 orchestrator 内的 StreamAggregator
- 不决策 tool 执行 — 属于 `@ema-agent/tool`
- 不管理 API key — 属于 config 包
