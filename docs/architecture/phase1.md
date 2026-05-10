# Phase 1 — 地基（骨架底座）

**状态**：✅ 已完成  
**验证**：`pnpm typecheck` 四包零错误，`pnpm --filter @ema-agent/hook test` 6/6 通过

---

## 1. 目标

在任何业务功能开始之前，先打通三件事：

1. **Monorepo 能跑** — 包之间能互相 import，turbo 能按依赖顺序 build
2. **数据有地方存** — SQLite 能建表、能迁移、所有表都有类型安全的 Repo
3. **横切机制到位** — HookBus 能注册/触发，后续所有副作用都挂上去，不进主循环

这三件事是后续所有包的前置条件。不打通就上 Engine，一定返工。

---

## 2. 交付清单

| 序 | 路径 | 交付物 |
|---|---|---|
| 1 | 根目录 | `pnpm-workspace.yaml` / `turbo.json` / `tsconfig.base.json` / `package.json` |
| 2 | `packages/contracts` | brand ID 类型 + `EmaStreamEvent` 联合类型 + `ErrorCode` |
| 3 | `packages/storage` | `Database` + `MigrationsRunner` + `001_initial.sql`（15张表）+ 8个 Repo |
| 4 | `packages/hook` | `HookBus` 实现 + 14个事件 + 优先级常量 + 测试 |
| 5 | `apps/core` | Hono server + `emaAuth` 中间件 + `/health` + `wiring.ts` + SSE 工具 + Orchestrator 骨架 |

---

## 3. 包结构与依赖

```
contracts          ← 零运行时依赖，纯类型
    ↑
storage            ← depends on: contracts, better-sqlite3
    ↑
hook               ← depends on: contracts
    ↑
apps/core          ← depends on: contracts, storage, hook, hono
```

`contracts` 必须最先 build，其他包的 `typecheck` 依赖它的 `dist/`。

---

## 4. 各包说明

### 4.1 `packages/contracts`

**只做类型，零运行时依赖。**

四个文件：

- `ids.ts` — Brand ID 类型（`SessionId` / `TurnId` / `MessageId` / `CharacterCardId` / `ArtifactId` / `ModelId` / `ProviderId`）+ 基础枚举（`TurnMode` / `AgentSubMode` / `TurnStatus` / `MessageRole` / `MessageKind`）
- `turns.ts` — `TurnRequest` / `UsageSummary` / `TurnState`
- `errors.ts` — `ErrorCode` 联合类型 + `EmaError` 接口，覆盖 auth / provider / tool / memory / narrative / storage / tts / stt / turn / system 各域
- `events.ts` — `EmaStreamEvent` 联合类型，28个事件变体，从 `turn_started` 到 `heartbeat`

Brand ID 的用途：防止把 `SessionId` 传进需要 `TurnId` 的参数。编译期报错，零运行时开销。

### 4.2 `packages/storage`

**SQLite 访问层，手写 SQL，无 ORM。**

核心文件：

- `database.ts` — `Database` 类，构造函数里固定开 `WAL` + `foreign_keys = ON` + `synchronous = NORMAL`
- `migrations.ts` — `MigrationsRunner`，用 `PRAGMA user_version` 跟踪版本，每个迁移在事务里执行后立即更新版本号
- `migrations/001_initial.sql` — 15 张表一次建完（见下方表清单）

**8 个 Repository：**

| Repo | 主要职责 |
|---|---|
| `SessionsRepo` | session CRUD，按 `updated_at DESC` 列表，支持 archive |
| `TurnsRepo` | turn 状态机（pending→running→completed/failed/aborted），`abortStale()` 处理异常重启 |
| `MessagesRepo` | 按 session/turn 查消息，支持标记 `interrupted` |
| `CharacterCardsRepo` | activate 用事务保证全表只有一行 `is_active=1` |
| `SettingsRepo` | `INSERT OR REPLACE` 的 upsert，key/value 存 JSON |
| `ProviderHealthRepo` | upsert 时自动累加 `consecutive_fails`，status 变回 ok 时清零 |
| `Live2DModelsRepo` | 资产 CRUD，`is_builtin=1` 的记录不可删除 |
| `TelemetryRepo` | 事件落盘 + turn usage 记录 |

**数据库 15 张表：**

```
sessions / turns / messages
provider_configs / model_catalog / model_bindings
memory_items
attachments / attachment_chunks
artifacts
permission_grants
live2d_models / character_cards
provider_health
settings
telemetry_events / turn_usage
```

### 4.3 `packages/hook`

**横切关注点的唯一实现路径。**

14 个事件：

```
beforeLlm / afterLlmDelta / afterLlmComplete / afterMessage
beforeToolUse / afterToolUse / onToolFailure
beforeCompact / afterCompact
onTurnStart / onTurnEnd / onTurnAbort
onCharacterCardSwitch / onEmotionChange
```

`HookBus` 行为：

- `register(event, handler, { priority?, name? })` 返回 unregister 函数
- `trigger(event, ctx)` 串行执行，按 priority 升序，任一 handler 返回 `abort` 立即中止
- handler 抛异常 = `{ kind: 'abort', reason: error.message }`
- `HookResult` 三种：`continue` / `replace` / `abort`
- `list(event?)` 调试用，列出已注册的 handler

优先级常量（`PRIORITY`）：`FIRST=10` / `EARLY=20` / `DEFAULT=100` / `LATE=200`

### 4.4 `apps/core`

**ema-core sidecar 骨架，目前只能响应 `/health`。**

- `auth.ts` — `emaAuth()` 中间件，读 `EMA_SHARED_SECRET` 环境变量，`/health` 路由跳过检查，环境变量缺失时打警告但不阻断（dev 模式）
- `server.ts` — Hono 装配，CORS 限制 localhost，挂 auth 中间件，挂 `/health` 路由，统一 404/500 handler
- `wiring.ts` — `wire(db)` 返回 `AppBindings`，目前只装 `db + hookBus`，后续 Phase 在这里注册各包的 hook
- `index.ts` — 启动入口，端口扫描（3421→3430），数据库迁移，优雅关闭
- `sse/writer.ts` — `sseStream()` 把 `AsyncIterable<EmaStreamEvent>` 转 SSE 字符串，含 15s 心跳
- `sse/event-store.ts` — `TurnEventStore`，按 turnId 缓存事件，支持断线重连重放，终态事件后 60s 自动淘汰
- `orchestrator/orchestrator.ts` — 骨架，目前只触发 `onTurnStart`/`onTurnEnd` hook，返回占位事件，Phase 2 替换为真实 Engine

---

## 5. 关键设计决策

**为什么用 `PRAGMA user_version` 而不是迁移表？**  
迁移表本身需要建表，有鸡生蛋问题。`user_version` 是 SQLite 内置整数，天然原子，读写零 SQL。代价是只能顺序迁移，没有 down migration——对单机本地应用完全够用。

**为什么 `CharacterCardsRepo.activate()` 用 `transaction()`？**  
activate 需要先把全表 `is_active` 置 0，再把目标行置 1。如果中间崩了，数据库里会出现零张激活卡，导致启动时找不到角色卡。事务保证这两步原子完成。

**为什么 HookBus 串行而不是 `Promise.all` 并发？**  
handler 之间有顺序依赖。`beforeLlm` 里 character-card 先注入 systemPrompt，memory 才能在它后面拼 RecallBundle；`beforeToolUse` 里 permission 必须阻塞通过才能让 tool 执行。并发会破坏这个顺序契约。

**为什么 `contracts` 包不能有运行时依赖？**  
前端（Tauri webview）也会 import `contracts` 共享类型。如果 contracts 引入了 Node.js 专用包，前端打包就会报错。纯类型导出 = 任意环境可用。

**为什么 `emaAuth()` 在 dev 模式下不阻断？**  
开发时不走 Tauri，没有 `EMA_SHARED_SECRET`。如果强制校验，`curl /health` 都跑不了。生产时 Tauri 一定会注入这个环境变量，安全不受影响。

---

## 6. 已知局限（Phase 2 接手点）

| 问题 | 位置 | Phase 2 怎么处理 |
|---|---|---|
| Orchestrator 返回占位事件 | `orchestrator.ts` | 替换为真实 ConversationEngine / AgentEngine |
| `TurnEventStore.evictExpired()` 无人调用 | `sse/event-store.ts` | 在 turns 路由或定时器里调 |
| `wiring.ts` 只装了 db + hooks | `wiring.ts` | Phase 2~6 逐步注入：llm / session / memory / characterCard / emotion |
| 没有 `/api/turns` 路由 | `routes/` | Phase 2 核心任务 |
| storage 里 Phase 1 只用到 5 张表 | `001_initial.sql` | 其余 10 张随对应包实现时激活 |

---

## 7. 验证方法

```bash
# 全部 typecheck（零错误）
pnpm --filter @ema-agent/contracts typecheck
pnpm --filter @ema-agent/storage typecheck
pnpm --filter @ema-agent/hook typecheck
pnpm --filter @ema-agent/core typecheck

# hook 单测（6/6）
pnpm --filter @ema-agent/hook test

# 手动跑 core（需先 build deps）
pnpm --filter @ema-agent/contracts build
pnpm --filter @ema-agent/storage build
pnpm --filter @ema-agent/hook build
pnpm --filter @ema-agent/core dev
# 另开终端
curl http://localhost:3421/health
# 期望返回：{"status":"ok","version":"0.1.0","ts":<timestamp>}
```