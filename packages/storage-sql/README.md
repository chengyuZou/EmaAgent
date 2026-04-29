# @ema-agent/storage-sql

SQLite 持久化层，实现 `@ema-agent/core-types` 中定义的 `SessionRepository`、`TurnRepository`、`ArtifactRepository` 三个仓储接口。

## 设计原则

- **纯函数映射**：每张表一个 `rowToXxx(row)` 函数，数据库行 ↔ 实体一一对应，不做业务计算
- **手写 SQL**：5 张表，不上 ORM。出问题时直接看 SQL 字符串，零抽象层
- **同步驱动**：使用 `better-sqlite3`，Electron 桌面场景最优，无需 async 开销
- **WAL 模式**：读写并发友好，单连接即可

## 文件结构

```
src/
  index.ts          # barrel export: createSqliteStorage(dbPath) 工厂函数
  connection.ts     # SQLite 连接管理，单例，启用 WAL
  schema.ts         # DDL + 版本化 migration（schema_version 表）
  sessions.ts       # SessionRepository 实现
  messages.ts       # 消息 CRUD（SessionRepository 内部委托）
  turns.ts          # TurnRepository 实现
  artifacts.ts      # ArtifactRepository 实现
```

## 表设计

### sessions

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | `SessionId` |
| `title` | `TEXT NOT NULL` | 会话标题 |
| `last_mode` | `TEXT NOT NULL DEFAULT 'chat'` | `EmaMode` |
| `full_access` | `INTEGER NOT NULL DEFAULT 1` | 是否完全访问 |
| `active_skills` | `TEXT NOT NULL DEFAULT '[]'` | JSON 数组，技能列表 |
| `title_status` | `TEXT NOT NULL DEFAULT 'default'` | `SessionTitleStatus` |
| `title_updated_at` | `INTEGER` | 标题更新时间 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(updated_at DESC)`

---

### messages

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | `MessageId` |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `role` | `TEXT NOT NULL` | `"user"` / `"assistant"` / `"system"` |
| `content_blocks` | `TEXT NOT NULL DEFAULT '[]'` | JSON，`MessageContentBlock[]` |
| `request_id` | `TEXT` | 关联的 Turn RequestId |
| `status` | `TEXT NOT NULL DEFAULT 'complete'` | `MessageStatus` |
| `error_code` | `TEXT` | 错误码 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(session_id, created_at)`

> **为什么 contentBlocks 存 JSON 而不拆表？**
>
> 拆表（每个 block 一行）的操作次数和整列 JSON 完全一样（都是 N 次写），但拆表多了外键、多了业务索引、加载历史消息时还要 JOIN 拼装。没有收益，徒增复杂度。整存整取是最优解。

---

## SSE 流式追加策略

SSE 循环使用 try/catch 包裹：正常路径逐 block 写入，异常路径落盘错误状态。

```typescript
// 伪代码：SSE 消费循环
try {
  for await (const chunk of sseStream) {
    const block = parseBlock(chunk)
    blocks.push(block)
    upsertMessage({ ...message, contentBlocks: blocks, status: "generating" })
  }
  // stream 正常结束
  upsertMessage({ ...message, contentBlocks: blocks, status: "complete" })
} catch (err) {
  // 任何异常（网络断开、LLM 返回 500、JSON 解析失败）都落盘 error
  upsertMessage({
    ...message,
    contentBlocks: blocks,  // 保留已接收的部分内容
    status: "error",
    errorCode: normalizeErrorCode(err),
  })
}
```

| 场景 | 数据库状态 | 前端行为 |
|---|---|---|
| 第 1 个 block 前抛异常 | 1 行，`content_blocks=[]`，`status='error'`，`errorCode` 已填 | 显示错误提示 + "重试"按钮 |
| 跑了 N 个 block 后抛异常 | 1 行，`content_blocks` 有 N 个 block，`status='error'` | 展示已接收内容（灰色） + 错误横幅 + "重新生成"按钮 |
| 跑了 N 个 block 后进程崩溃（未进 catch） | 1 行，`content_blocks` 有 N 个 block，`status='generating'` | 展示部分内容 + "重新生成"按钮（前端按 `generating` 超时兜底） |
| stream 正常结束 | 1 行，`content_blocks` 完整，`status='complete'` | 正常展示 |

**三层保障**：
1. **正常错误** → catch 块直接写 `status='error'` + `errorCode`
2. **进程崩溃** → WAL 模式下已落盘的 UPDATE 不会丢，下次加载时 `status='generating'` 触发前端超时兜底
3. **JSON 损坏** → WAL 原子写入保证不会出现半个 JSON

---

### turns

| 列 | 类型 | 说明 |
|---|---|---|
| `request_id` | `TEXT PK` | `RequestId`，一轮 turn 的唯一标识 |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `mode` | `TEXT NOT NULL` | `EmaMode` |
| `status` | `TEXT NOT NULL DEFAULT 'queued'` | `TurnStatus` |
| `model_id` | `TEXT` | `ModelId` |
| `provider_id` | `TEXT` | `ProviderId` |
| `started_at` | `INTEGER NOT NULL` | `UnixMs` |
| `ended_at` | `INTEGER` | `UnixMs` |
| `usage_json` | `TEXT` | JSON，`UsageView` |

索引：`(session_id, started_at DESC)`

---

### artifacts

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | `ArtifactId` |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `request_id` | `TEXT NOT NULL` | 产生此产物的 RequestId |
| `kind` | `TEXT NOT NULL` | `ArtifactKind` |
| `title` | `TEXT NOT NULL` | 产物标题 |
| `description` | `TEXT` | 一句话描述 |
| `mime` | `TEXT NOT NULL DEFAULT 'text/plain'` | MIME 类型 |
| `target_paths` | `TEXT` | JSON 数组，文件路径列表 |
| `params` | `TEXT` | JSON，`ArtifactParams` |
| `status` | `TEXT NOT NULL DEFAULT 'draft'` | `ArtifactStatus` |
| `content` | `TEXT NOT NULL DEFAULT ''` | 产物文本内容 |
| `payload_type` | `TEXT NOT NULL DEFAULT 'inline'` | `"inline"` / `"file"` / `"db"` |
| `binary_base64` | `TEXT` | 二进制内容 base64 |
| `content_hash` | `TEXT` | 内容哈希 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(session_id, created_at DESC)`, `(request_id)`

---

### schema_version

| 列 | 类型 | 说明 |
|---|---|---|
| `version` | `INTEGER PRIMARY KEY` | 当前 schema 版本号 |
| `applied_at` | `INTEGER NOT NULL` | 迁移执行时间 |

## 迁移策略

采用**版本化正向迁移**：`schema.ts` 导出一个 `migrate(db)` 函数，对比 `schema_version` 表与代码中硬编码的 `LATEST_VERSION`，按顺序执行缺失的 DDL。不生成 `.sql` 文件，DDL 直接写在 TypeScript 中，保证类型安全。

```typescript
// schema.ts 伪代码
const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: createV1Tables,
  // 未来新增版本在此追加
}

export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number
  for (let v = current + 1; v <= LATEST_VERSION; v++) {
    MIGRATIONS[v]?.(db)
    db.pragma(`user_version = ${v}`)
  }
}
```

## 公共 API

```typescript
import { createSqliteStorage } from "@ema-agent/storage-sql"

const storage = createSqliteStorage("~/.ema-agent/data.db")

// storage 对象直接实现了所有仓储接口
const { sessions, turns, artifacts } = storage

// 会话操作
const session = await sessions.create({ id: asId<SessionId>("s1") })
const list = await sessions.list()

// 消息操作
await sessions.appendMessage(sessionId, message)
const page = await sessions.listMessages(sessionId, { limit: 20 })

// Turn 操作
const turn = await turns.createTurn({ requestId, sessionId, mode: "agent" })
await turns.updateTurn({ requestId, status: "completed" })

// 产物操作
const artifact = await artifacts.create(summary, content)
const items = await artifacts.listBySession(sessionId)
```

## 工厂函数签名

```typescript
export function createSqliteStorage(dbPath: string): {
  sessions: SessionRepository
  turns: TurnRepository
  artifacts: ArtifactRepository
  close: () => void
}
```

## 依赖

- **`@ema-agent/core-types`** — 所有实体类型与仓储接口
- **`better-sqlite3`** — Node.js 同步 SQLite3 绑定

## 不做什么

- 不提供通用查询构建器——仓储接口已限定操作范围
- 不处理文件存储——产物 `payload_type: "file"` 只存路径引用，文件 I/O 由上层的 workspace 服务负责
- 不做 business logic——只做存取映射