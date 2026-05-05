# @ema-agent/storage-sql

SQLite 持久化层。10 个仓储实现 + FTS5 全文索引 + WAL 模式迁移。所有 Repository 接口和实现均位于此包内，不由 `@ema-agent/core-types` 承载。

## 设计原则

- **纯函数映射**：每张表一个 `rowToXxx(row)` 函数，数据库行 ↔ 实体一一对应，不做业务计算
- **手写 SQL**：不上 ORM。出问题时直接看 SQL 字符串，零抽象层
- **better-sqlite3 同步驱动**：所有 repo 方法标记 `async` 以保持 API 一致性，底层调用 better-sqlite3 同步方法
- **WAL 模式**：读写并发友好，单连接即可

## 文件结构

```
src/
  index.ts              # barrel export: createSqliteStorage(dbPath) 工厂函数
  connection.ts         # SQLite 连接管理，WAL + 迁移 + FTS
  schema.ts             # DDL + 5 版正向迁移（user_version PRAGMA）
  fts.ts                # FTS5 全文索引（memory_facts + attachment_chunks）+
                        #   重建 / 搜索 / escapeLike 辅助
  repos/
    session-repo.ts           # SessionRepository
    message-repo.ts           # MessageRepository
    turn-repo.ts              # TurnRepository
    artifact-repo.ts          # ArtifactRepository
    attachment-repo.ts        # AttachmentRepository
    memory-fact-repo.ts       # MemoryRepository (facts + session_summaries)
    telemetry-repo.ts         # TelemetryRepository
    provider-config-repo.ts   # ProviderConfigRepository
    model-binding-repo.ts     # ModelBindingRepository
    permission-grant-repo.ts  # PermissionGrantRepository
```

## 表设计（12 表 + 2 FTS5 虚拟表）

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
> 拆表（每个 block 一行）的操作次数和整列 JSON 完全一样，但拆表多了外键、业务索引、加载时还要 JOIN。没有收益。整存整取是最优解。

---

### SSE 流式追加策略

SSE 循环使用 try/catch 包裹：正常路径逐 block 写入，异常路径落盘错误状态。

```typescript
// 伪代码：SSE 消费循环
try {
  for await (const chunk of sseStream) {
    const block = parseBlock(chunk)
    blocks.push(block)
    upsertMessage({ ...message, contentBlocks: blocks, status: "generating" })
  }
  upsertMessage({ ...message, contentBlocks: blocks, status: "complete" })
} catch (err) {
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
| 第 1 个 block 前抛异常 | `content_blocks=[]`，`status='error'`，`errorCode` 已填 | 显示错误提示 + 重试 |
| 跑了 N 个 block 后抛异常 | `content_blocks` 有 N 个 block，`status='error'` | 展示已接收内容（灰色） + 错误横幅 |
| 跑了 N 个 block 后进程崩溃 | `content_blocks` 有 N 个 block，`status='generating'` | 展示部分内容 + 重新生成（前端按 `generating` 超时兜底） |
| stream 正常结束 | `content_blocks` 完整，`status='complete'` | 正常展示 |

**三层保障**：
1. **正常错误** → catch 块直接写 `status='error'` + `errorCode`
2. **进程崩溃** → WAL 模式下已落盘的 UPDATE 不会丢，下次加载时 `status='generating'` 触发前端超时兜底
3. **JSON 损坏** → WAL 原子写入保证不会出现半个 JSON

---

### turns

| 列 | 类型 | 说明 |
|---|---|---|
| `request_id` | `TEXT PK` | `RequestId` |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `mode` | `TEXT NOT NULL` | `EmaMode` |
| `status` | `TEXT NOT NULL DEFAULT 'queued'` | `TurnStatus` |
| `model_id` | `TEXT` | `ModelId` |
| `provider_id` | `TEXT` | `ProviderId` |
| `started_at` | `INTEGER NOT NULL` | `UnixMs` |
| `ended_at` | `INTEGER` | `UnixMs` |
| `usage_json` | `TEXT` | JSON，`UsageView` |
| `error_code` | `TEXT` | v2 迁移添加 |
| `error_message` | `TEXT` | v2 迁移添加 |

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
| `payload_type` | `TEXT NOT NULL DEFAULT 'inline'` | `"inline"` / `"file"` / `"db"` |
| `payload_content` | `TEXT` | 具体内容或路径 |
| `binary_base64` | `TEXT` | 二进制内容 base64 |
| `content_hash` | `TEXT` | 内容哈希 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(session_id, created_at DESC)`, `(request_id)`

---

### attachments（v3 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | `AttachmentId` |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `file_name` | `TEXT NOT NULL` | 原始文件名 |
| `mime` | `TEXT NOT NULL` | MIME 类型 |
| `size_bytes` | `INTEGER NOT NULL` | 文件大小 |
| `sha256` | `TEXT NOT NULL` | 内容哈希 |
| `status` | `TEXT NOT NULL` | `AttachmentStatus` |
| `text_preview` | `TEXT` | 文本预览 |
| `error_message` | `TEXT` | 处理错误信息 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(session_id, created_at DESC)`

### attachment_chunks（v3 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Chunk ID |
| `attachment_id` | `TEXT NOT NULL` | FK → attachments |
| `session_id` | `TEXT NOT NULL` | FK → sessions（冗余，加速查询） |
| `chunk_index` | `INTEGER NOT NULL` | 分块序号 |
| `text` | `TEXT NOT NULL` | 切分后的文本块 |
| `token_count` | `INTEGER NOT NULL` | token 估数 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(attachment_id, chunk_index)` + FTS5 虚拟表 `attachment_chunks_fts`

---

### memory_facts（v4 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Fact ID |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `kind` | `TEXT NOT NULL` | `MemoryFactKind`（user/feedback/project/reference） |
| `content` | `TEXT NOT NULL` | 事实内容 |
| `confidence` | `REAL NOT NULL` | 置信度 0~1 |
| `source` | `TEXT NOT NULL` | 来源标注 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |
| `last_used_at` | `INTEGER` | 最后被召回的时间 |

索引：`(session_id, kind)` + FTS5 虚拟表 `memory_facts_fts`

### session_summaries（v4 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `session_id` | `TEXT PK` | FK → sessions |
| `summary_text` | `TEXT NOT NULL` | 滚动摘要文本 |
| `token_count` | `INTEGER NOT NULL` | 摘要 token 数 |
| `covered_message_count` | `INTEGER NOT NULL` | 覆盖的消息条数 |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

### telemetry_events（v4 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Event ID |
| `trace_id` | `TEXT` | 追踪 ID |
| `request_id` | `TEXT` | 关联 Turn |
| `session_id` | `TEXT` | 关联 Session |
| `type` | `TEXT NOT NULL` | 事件类型 |
| `level` | `TEXT NOT NULL` | 日志级别 |
| `payload_json` | `TEXT NOT NULL` | JSON 载荷 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |

索引：`(created_at DESC)`, `(request_id)`

---

### provider_configs（v5 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Provider ID |
| `display_name` | `TEXT NOT NULL` | 展示名称 |
| `category` | `TEXT NOT NULL` | `ProviderCategory` |
| `kind` | `TEXT NOT NULL` | `ProviderKind` |
| `enabled` | `INTEGER NOT NULL DEFAULT 1` | 是否启用 |
| `configured` | `INTEGER NOT NULL DEFAULT 1` | 是否已配置 |
| `credential_id` | `TEXT` | Tauri Stronghold 凭证引用 |
| `base_url` | `TEXT` | 自定义 API base URL |
| `api_key_encrypted` | `TEXT` | 加密后的 API key |
| `headers_json` | `TEXT` | 自定义 HTTP 头 |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

### model_bindings（v5 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Binding ID |
| `role` | `TEXT NOT NULL UNIQUE` | `ModelRole`（每 role 唯一一条） |
| `provider_id` | `TEXT NOT NULL` | Provider 引用 |
| `model_id` | `TEXT NOT NULL` | 模型 ID |
| `created_at` | `INTEGER NOT NULL` | `UnixMs` |
| `updated_at` | `INTEGER NOT NULL` | `UnixMs` |

唯一索引：`(role)`

### permission_grants（v5 迁移）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | Grant ID |
| `session_id` | `TEXT NOT NULL` | FK → sessions |
| `tool_name` | `TEXT NOT NULL` | 工具名称 |
| `decision` | `TEXT NOT NULL` | `"allow"` / `"deny"` |
| `scope` | `TEXT NOT NULL DEFAULT 'once'` | `"once"` / `"session"` / `"always"` |
| `risk` | `TEXT NOT NULL` | 风险级别 |
| `path_pattern` | `TEXT` | 路径匹配模式 |
| `decided_at` | `INTEGER NOT NULL` | `UnixMs` |
| `expires_at` | `INTEGER` | 过期时间 |

索引：`(session_id, tool_name)`

---

## 迁移策略

采用**版本化正向迁移**：`schema.ts` 利用 SQLite 原生的 `user_version` PRAGMA 追踪版本号。对比当前版本与硬编码的 `LATEST_VERSION`，按顺序开启事务执行缺失的 DDL。

```typescript
const LATEST_VERSION = 5

const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => { /* sessions + messages + turns + artifacts */ },
  2: (db) => { /* turns 新增 error_code / error_message */ },
  3: (db) => { /* attachments + attachment_chunks */ },
  4: (db) => { /* memory_facts + session_summaries + telemetry_events */ },
  5: (db) => { /* provider_configs + model_bindings + permission_grants */ },
}

export function migrate(db: Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number
  const transaction = db.transaction(() => {
    for (let v = currentVersion + 1; v <= LATEST_VERSION; v++) {
      MIGRATIONS[v]?.(db)
      db.pragma(`user_version = ${v}`)
    }
  })
  transaction()
}
```

不生成 `.sql` 文件，DDL 直接写在 TypeScript 中。

## 公共 API

```typescript
import { createSqliteStorage } from "@ema-agent/storage-sql"

const storage = createSqliteStorage("~/.ema-agent/data.db")

// 10 个仓储 + 关闭 + FTS 辅助
const {
  sessions,          // SessionRepository
  turns,             // TurnRepository
  messages,          // MessageRepository
  artifacts,         // ArtifactRepository
  attachments,       // AttachmentRepository
  memory,            // MemoryRepository
  telemetry,         // TelemetryRepository
  providerConfigs,   // ProviderConfigRepository
  modelBindings,     // ModelBindingRepository
  permissionGrants,  // PermissionGrantRepository
  close,             // () => void
} = storage

// 会话操作
const session = await sessions.create({ id: asId<SessionId>("s1") })
const list = await sessions.list()

// 消息操作
await messages.create({ messageId, sessionId, role: "user", contentBlocks, requestId })
const page = await messages.listBySession(sessionId, { limit: 20 })

// Turn 操作
const turn = await turns.createTurn({ requestId, sessionId, mode: "agent" })
const detail = await turns.getTurnById(requestId)

// 产物操作
const artifact = await artifacts.create(summary, content)
const items = await artifacts.listBySession(sessionId)

// FTS5 全文搜索
import { searchMemoryFactsFts, searchAttachmentChunksFts } from "@ema-agent/storage-sql"
```

## 工厂函数签名

```typescript
export function createSqliteStorage(dbPath: string): {
  sessions: SessionRepository
  turns: TurnRepository
  messages: MessageRepository
  artifacts: ArtifactRepository
  attachments: AttachmentRepository
  memory: MemoryRepository
  telemetry: TelemetryRepository
  providerConfigs: ProviderConfigRepository
  modelBindings: ModelBindingRepository
  permissionGrants: PermissionGrantRepository
  close: () => void
}
```

## 依赖

- **`@ema-agent/core-types`** — 实体类型（`TurnRecord`、`SessionState` 等）
- **`@ema-agent/constants-core`** — 运行时常量（`SESSION_TITLE_MAX_LENGTH` 等）
- **`better-sqlite3`** — Node.js 同步 SQLite3 绑定

## 不做什么

- 不提供通用查询构建器——仓储接口已限定操作范围
- 不处理文件存储——产物 `payload_type: "file"` 只存路径引用，文件 I/O 由上层的 workspace 服务负责
- 不做 business logic——只做存取映射
- 不强制消息挂在 SessionRepository 下——`messages` 是独立仓储，与 `sessions` 平级
