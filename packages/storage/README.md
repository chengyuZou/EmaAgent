# @ema-agent/storage

EmaAgent 的 **SQLite 访问层**。`better-sqlite3` + 手写 SQL(禁 ORM)。只提供 Repository(CRUD),不碰业务逻辑 / LLM / embedding / 文件 IO。

> 没学过 SQL 也能读懂本文件:关键概念都有中文解释。

---

## 一、定位与边界

**做什么**:
- 用 SQLite 持久化所有业务数据(会话 / Provider 配置 / 记忆 / KB 文档 / Agent 任务等)
- 提供 38 个 `Repo` 类,每个负责一组表的增删改查
- 提供迁移器(`MigrationsRunner`)管理表结构演进

**不做什么**(Facade 边界):
- 不做业务逻辑(权限判断 / LLM 调用 / embedding 计算 -- 那是 `permission` / `llm` / `ebd-client` 包)
- 不碰文件系统(音频 / Artifact 正文 / 附件文件由 `tts` / `artifact` / `attachment` 包管,storage 只存路径)
- 不做路由 / 不接 HTTP
- **例外**:`zh-tokenizer.ts`(jieba 中文分词)放在本包,因为 KB 的 FTS5 全文索引紧耦合分词策略(索引怎么建决定怎么查)。若未来其他包也要中文分词,应提取成独立包。

**核心原则**:Repo 只接收 `SqliteDb`,不关心自己是 `profile` 还是 `data` 还是 `kb` -- 由装配层(`apps/core` wiring)把每个 Repo 和正确的 DB 配对。

---

## 二、三个数据库

EmaAgent 用 **3 个独立 SQLite 数据库**,各自独立 `user_version`(版本号互不影响):

| db | 文件路径 | 生命周期 | 内容 |
|---|---|---|---|
| `profile` | `~/.ema-agent/profile.db` | 全局,跟**用户**走,跨所有工作区共享 | Provider 配置 / 模型绑定 / 角色卡 / 设置 / skills 索引 / 全局记忆(节点图+条目)/ KB 注册表 |
| `data` | `{activeDataDir}/data.db` | 每个工作区一个,用户切换数据目录时整体换 | sessions / turns / messages / branches / 音频 / artifacts / 附件 / agent tasks / per-session 记忆 / kb_activations |
| `kb` | `{kbPath}/kb.db` | 每个命名知识库独立一个 | document_assets / document_chunks / FTS5 索引 / kb_ingest_tasks |

**为什么分三个**:
- `profile` 跨工作区:换数据目录时 Provider 配置不该丢
- `data` 按工作区:不同工作区隔离会话
- `kb` 按知识库:KB 文档可能很大,独立文件方便管理 / 备份 / 删除

运行时三个 DB 同时打开,`Database` 类各实例化一个。

---

## 三、架构

### `Database`(`src/database.ts`)
SQLite 封装。构造时:
- 打开 DB 文件(或 `:memory:`)
- 设 pragma:
  - `journal_mode=WAL`(写前日志,并发读不阻塞写)
  - `foreign_keys=ON`(开外键约束,SQLite 默认关)
  - `synchronous=NORMAL`(WAL 下安全且快)
  - `busy_timeout=5000`(多连接并发写等 5s,防 SQLITE_BUSY)
  - `cache_size=-20000` / `temp_store=MEMORY` / `mmap_size=256MB`(性能调优,仅文件 DB 设 mmap)
- 构造 try/catch:pragma 失败时 close 句柄,防泄漏
- `closed`/`migrated` 标志:close 幂等 + migrate 幂等 no-op + use-after-close 守卫
- 创建 `MigrationsRunner`

生命周期:构造 -> `migrate()`(必须调,建表)-> 使用 -> `close()`。

### `MigrationsRunner`(`src/migrations.ts`)
迁移器(表结构版本控制,详见下文「迁移机制」)。

### 38 个 Repo(`src/repos/`)
每个 Repo 一组表,只接 `SqliteDb`,方法都是参数化 SQL(防注入)。导出在 `src/index.ts`。

---

## 四、表清单(按 db 分组)

### `data.db`(会话与运行时)

**会话核心**
| 表 | 职责 |
|---|---|
| `sessions` | 会话主表:标题 / 角色卡 / 工作区 / 置顶 / 归档 / 分组 / 分支指针 / 最后活动时间 |
| `branches` | 会话内分支树:`parent_branch_id` 自引用成树,`fork_from_turn_id` 标记从哪轮分叉 |
| `turns` | 一轮对话:模式(chat/narrative/agent)/ 状态 / 用户输入 / token 用量 / 所属分支 |
| `messages` | 单条消息:user/assistant/system,`kind` 区分 normal/context/tool_results/summary/narrative_context,正文存 `blocks_json` |
| `pending_fragments` | 流式生成中的碎片暂存(还没拼成完整 message 前的增量) |

**per-session 记忆**
| 表 | 职责 |
|---|---|
| `session_notes` | 每会话的 L1 滚动摘要(文本) |
| `memory_session_state` | 每会话的记忆召回状态(已浮现 / 用户覆盖) |
| `memory_tasks` | 记忆后台任务队列(extraction/maintenance/embedding_refresh/consolidation) |

**音频 / 附件 / 产物**
| 表 | 职责 |
|---|---|
| `turn_audio_segments` | TTS 分段音频(每句一个文件) |
| `turn_audio_merged` | 合并后的整轮音频(重播用) |
| `turn_attachments` | per-turn 文件附件(路径引用) |
| `artifacts` | 产物(代码/diff/图片),`content_location` 区分 inline 存正文 / file 存路径 |

**权限 / 遥测 / 用量 / agent**
| 表 | 职责 |
|---|---|
| `permission_grants` | 权限授予(allow/ask/forbidden,session/persistent) |
| `telemetry_events` | 遥测事件 |
| `turn_usage` | per-turn 用量(provider/model/token/cost) |
| `agent_tasks` | agent 运行实例状态机(running/waiting_user/completed/failed/cancelled) |
| `agent_task_messages` | agent 对话 transcript |
| `kb_activations` | 哪个 session/turn 用了哪个 KB 文档(`call_id` 聚合) |
| `message_search_documents` | Session 消息的用户可见纯文本与 jieba tokens 投影 |
| `message_search_fts` | Session 消息 FTS5 倒排索引，不保存 thinking/tool 参数 |

### `profile.db`(全局用户级)

| 分组 | 表 |
|---|---|
| Provider 体系 | `provider_configs`(连接)/ `provider_health`(探测)/ 6 张 `provider_*_models`(模型池)/ `model_bindings`(模块->模型) |
| 角色 / 外观 | `live2d_models` / `character_cards` |
| 设置 / 插件 | `settings`(key-value)/ `mcp_servers` / `market_sources` / `skills`(磁盘 SKILL.md 的缓存索引) |
| 全局记忆 | `memory_nodes`(图节点,6 种类型)/ `memory_edges`(关系)/ `memory_node_lazy_updates`(懒更新队列)/ `memory_items`(4 种条目) |
| KB 注册 | `knowledge_bases`(命名 KB 的 id/name/path) |

### `kb.db`(每个命名知识库独立)

| 表 | 职责 |
|---|---|
| `document_assets` | 文档元信息(路径 / 状态 / embedding 模型 / 使用次数) |
| `document_chunks` | 文档分块(文本 / 分页 / 前后指针 / 父窗 / embedding BLOB) |
| `document_previews` | 预览(文本 / 缩略图) |
| `document_chunks_fts` | FTS5 全文索引(虚拟表,jieba 分词) |
| `kb_ingest_tasks` | 导入任务队列 |

---

## 五、迁移机制(表结构版本控制)

**为什么需要迁移**:代码有 git 版本,数据库表结构也要演进(加表 / 加列 / 改约束)。迁移就是管理这个演进的过程,保证老用户的数据库能升级到新结构。

**机制**:
1. 每条流(`profile`/`data`/`kb`)的迁移文件放 `src/migrations/{kind}/`,命名 `001_initial.sql` / `002_xxx.sql`,**编号即版本号**
2. SQLite 内置 `user_version` pragma(整数),记录"当前数据库跑到第几版"
3. 启动时 `MigrationsRunner.run()`:
   - 读 `user_version`(当前版本,比如 1)
   - `latest = 文件名前缀解析的最大编号`(如 `002_xxx.sql` -> 2,不靠文件数)
   - **compatibility gate**:若 `current > latest` throw 明确错误(老库遇到更高版本应用,fail-closed)
   - 从 `current+1` 跑到 `latest`,读对应 `00v_xxx.sql`,在**事务**里 `exec(sql)` + `user_version = v`
   - 跳号(文件缺失)throw 明确错误,不静默跳过
   - 事务保证:中途失败全回滚,不留半成品

**当前版本**:data 流 v5 / profile 流 v2 / kb 流 v1

**铁律(B-059 已修复)**:
- 迁移**只追加,不回退,不 squash(合并)**。一旦发布,编号不可改
- `latest` 从文件名前缀解析最大编号(不靠文件数),避免 squash/跳号时算错
- **compatibility gate**:老库 `user_version > latest` 时 throw 明确错误(fail-closed,提示"升级应用或备份重建"),防静默跳过。`profile/002_market_sources.sql` 是历史踩坑(001 squash 后旧库没 market_sources 表,用 002 补救)
- 改 schema = 新增 `003_xxx.sql`,不动旧文件
- 未来确需 squash:引入 `_migrations` checksum 表 + baseline(参考 Flyway),V1 不需要

**改 CHECK 约束**:SQLite 不能直接 `ALTER` CHECK,用"重命名旧表 -> 建新表(新 CHECK)-> `INSERT ... SELECT *` 拷数据 -> 删旧表"四步(见 `data/002_narrative_context.sql`)。

---

## 六、关键机制

### 事务
- `db.transaction(() => { ... })()` 包多步写操作,任一失败全回滚
- better-sqlite3 是**同步** API,单线程,事务内天然防并发(同一时刻只有一个事务在跑)

### 外键(FK)
- `foreign_keys=ON` 全局开启
- `ON DELETE CASCADE`:删父记录自动删子(如删 session 自动删其 turns/messages)
- `ON DELETE SET NULL`:删父记录把子的外键置 NULL(如删 turn,message.turn_id 置 NULL)
- `ON DELETE RESTRICT`:有子引用时禁止删父(如 model_bindings 引用的 provider 不能删)

### 游标分页
大列表不用 `OFFSET`(慢),用 keyset 游标:
- `sessions.listActive`:使用 Base64URL 编码的 V1 不透明游标，按 `(pinned DESC, last_activity_at DESC, id DESC)` 稳定翻页
- `document_chunks.findByAssetPaged`:游标 = 上一页最后一条的 `rowid`
- `document_assets.listPaged`:游标 = 上一页最后一条的 `created_at`

> 其他 Repo 的游标必须分别验证稳定 tie-breaker，不能照搬 Session cursor 格式。

### FTS5 中文全文检索(Session + KB)
- Session 搜索以 `messages` 为事实表，由 trigger 同步到 `message_search_documents` 和 `message_search_fts`
- 只提取字符串正文与 `type=text` block；thinking、tool_use、tool_result、媒体数据和内部 context 不进入索引
- migration 会回填升级前已有的 `normal` / `summary` 消息；fork、恢复导入和普通 insert 共用同一 trigger 管线
- `document_chunks.tokens` 列存 jieba 分词后的文本
- 3 个触发器(`doc_chunks_fts_ai/ad/au`)在 insert/delete/update 时自动同步到 `document_chunks_fts` 虚拟表
- `searchFts(query)` 查询时也用 jieba 分词,保证索引和查询用同一分词器(否则中文匹配不上)
- BM25 评分:SQLite 返回负值(越小越好),代码 negate 成正值(越大越好)

### 跨平台运行约束
- `Database` 启动时检测 SQLite `ENABLE_FTS5`，缺失时抛出带 capability/platform 的 `DatabaseCapabilityError`
- jieba 使用可捕获的懒加载；native 二进制缺失时降级为 unicode61 原始文本分词，不阻断应用启动
- lockfile 已包含 Windows x64/arm64、macOS x64/arm64、Linux glibc/musl 等 `@node-rs/jieba` 可选二进制
- 路径、文件名、大小写与原子替换仍必须由 Tauri Host / Core 文件 façade 处理，storage SQL 不拼接操作系统路径

### 向量检索(KB fallback)
- `document_chunks.embedding` 存 Float32 二进制 BLOB(4 字节 × dim)
- `searchByEmbedding`:读所有 embedding -> cosine 相似度 -> 排序取 topK
- 主索引是 HNSW(在 `knowledge-base` 包),本 repo 是 fallback

> ⚠️ 已知问题:fallback 全表反序列化 + O(N log N) 排序,大 KB 时冻结 UI(见 Batch-1 B-072)

---

## 七、Facade 索引(38 Repo)

按 db 分组,导出在 `src/index.ts`:

### data.db Repo
`SessionsRepo` / `TurnsRepo` / `MessagesRepo` / `BranchesRepo` / `ArtifactRepo` / `AttachmentRepo` / `SessionStatsRepo` + `DataDirStatsRepo`(`storage-stats.ts`)/ `AgentTasksRepo` / `AgentTaskMessagesRepo` / `PendingFragmentsRepo` / `SessionNotesRepo` / `MemoryTasksRepo`(data 侧)/ `MemorySessionStateRepo`

### profile.db Repo
`ProvidersRepo` / `ModelBindingsRepo` / `CharacterCardsRepo` / `SettingsRepo` / `Live2DModelsRepo` / `McpServersRepo` / `SkillsRepo` / `MarketSourcesRepo` / `MemoryNodesRepo` / `MemoryEdgesRepo` / `MemoryLazyUpdatesRepo` / `MemoryItemsRepo` / `MemoryTasksRepo`(profile 侧)/ `KbRegistryRepo` / 6 张 `Provider*ModelsRepo`

### kb.db Repo
`DocumentAssetRepo` / `DocumentChunkRepo` / `DocumentPreviewRepo` / `KbIngestTasksRepo`

> 注:`KbActivationsRepo` 在 data.db(kb_activations 表,session->KB 使用记录,跨 db 引用 kb_id/asset_id 无 FK)。`MemoryTasksRepo` 在 data 和 profile 都有(不同流,不同表)。

---

## 八、已知限制(Batch 1 审计发现)

详见 `D:\Github\Batch\Batch-1-storage.md`。关键:

### P0(数据损坏/丢失)
- **B-001** `restoreRows` 循环 FK:`branches.fork_from_turn_id` <-> `turns.branch_id` 互相引用,恢复顺序不对致 fork branch 导入必失败
- **B-004** `listForSessionFromSummary` 正序 `LIMIT 500` 截最早 500,丢最新上下文
- ~~**B-059** migration squash 老 `user_version` 静默跳过~~ ✅ 已修复(latest 从文件名解析 + compatibility gate + 跳号检测)

### P1(一致性/性能)
- **B-005** 跨 session 关系无复合 FK(turn.session_id 与 turn.branch_id 可能分属不同 session)
- **B-056** `agent_tasks` 缺 version 列,CAS 做不了(旧 worker 覆盖新状态)
- **B-058** `model-bindings` TS union 与 SQL CHECK 不一致 + `get()` 无 ORDER BY
- **B-060** 游标缺 ID tie-breaker / listGrouped N+1 / search JSON LIKE 全表扫
- **B-072** 向量 fallback O(N log N)
- **N-001** `activate`/`setActive` 不校验 id 存在,致 0 active
- **N-002** `market-sources.deleteById` 漏 builtin 守卫

### 跨包 bug(storage 侧已确认,主因在别包)
- B-003 Artifact 备份丢正文(core route)/ B-070 KB activation 配对(KB 包)/ B-049 embedding identity(KB/Memory)/ B-011 KB 重试(KB 包)/ B-017 Provider 删后旧 adapter(core wiring)/ B-013 向量分数(USearch)

---

## 九、开发指引

### 加一张新表
1. 在对应流的 `migrations/{kind}/` 新增 `003_xxx.sql`(编号只追加)
2. 写 `CREATE TABLE ...` + 索引
3. 在 `src/repos/` 新建 `xxx.ts`,实现 `Repo` 类(参数化 SQL)
4. 在 `src/index.ts` 导出 Repo + 类型
5. 在 `apps/core` wiring 里把 Repo 和对应 DB 配对

### 加列 / 改约束
- 加列:`ALTER TABLE ... ADD COLUMN ...`(简单)
- 改 CHECK:重建表四步(见 `data/002_narrative_context.sql`)

### 写 Repo 方法
- **必须参数化**(`?` 占位 + `.run(...)`)防 SQL 注入,禁止字符串拼 SQL
- `IN (?)` 子句:动态生成 `?,?,?` 占位,参数数超 999 要分批
- 多步写操作包 `db.transaction(() => { ... })()`
- 查询方法返回 typed row(`as RowType`)

### 命名
- 表名 / 列名:snake_case(`turn_id` / `created_at`)
- TS 接口 / 方法:camelCase(`turnId` / `findById`)
- 文件名:kebab-case(`document-chunk.ts`)

---

## 十、常用命令

```bash
pnpm --filter @ema-agent/storage typecheck       # 类型检查
pnpm --filter @ema-agent/storage build           # 构建(含复制 migrations 到 dist)
pnpm --filter @ema-agent/storage migrate         # 跑 profile + data 迁移
pnpm --filter @ema-agent/storage migrate:status  # 查看当前 user_version
```

> `build` 脚本特殊:`tsc` 后用 `cpSync` 把 `src/migrations` 复制到 `dist/migrations`(SQL 文件不编译,运行时按路径读)。

---

## 十一、依赖

- `better-sqlite3`:同步 SQLite 驱动(快、简单、单线程)
- `@node-rs/jieba`:中文分词(FTS5 用)
- `@ema-agent/contracts`:公共类型契约(只类型,无运行时依赖)
