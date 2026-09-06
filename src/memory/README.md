# @ema-agent/memory

`@ema-agent/memory` 负责 EmaAgent 的本地文件式长期记忆。它不保存 Turn 副本，也不允许 Agent 或前端直接写正式记忆；原始对话事实保留在 Session/Turn SQL，Memory 只保存自动提取和整合后的长期内容。

## 两条独立轨道

- Work：全局共享，记录稳定的工作偏好、习惯、协作方式和长期约束。
- Relationship：全局共享用户关系信息，并按 `character_name` 保存角色关系信息。

两轨共用 `memory-llm` 模型绑定，但各自拥有独立的 Extraction、Consolidation、Maintenance Job、SQL 提取结果和文件目录。Relationship Turn 没有 `character_name` 时不创建提取任务。

## 文件目录

```text
~/.ema-agent/memories/
├─ work/
│  ├─ MEMORY.md
│  ├─ memory_summary.md
│  ├─ topics/
│  └─ .git/
└─ relationship/
   ├─ shared_user_memory.md
   ├─ character_relations.md
   ├─ memory_summary.md
   ├─ characters/<character_name>/
   │  ├─ MEMORY.md
   │  └─ history/
   └─ .git/
```

Work 没有 `history/`。`memory_summary.md` 供 Turn 开始时注入，不进入 Memory List/Search/Read 的可读文件集合。正式 Markdown 可由用户在文件管理器中直接修改；下一次整合通过各轨 Git diff 读取这些修改。

## Turn 输入

Server 从已完成 Turn 投影标准 `@ema-agent/llm` `Message[]`，只保留按原顺序出现的 User 文本和 Assistant 文本。System、Tool Call、Tool Result、AskUser、reasoning、reminder、summary 与附件内容不进入 Memory。

同一份文本分别调用 Work 与 Relationship Extractor。外部 LLM 只允许返回：

```json
{}
```

或：

```json
{ "content": "本轨待整合内容" }
```

`{}` 只完成 Extraction Job，不写提取结果。

## SQL 与任务

Storage 提供 `MemoryRepo`。提取结果分表保存：

- `memory_work_extractions`：`turn_id`、`job_id`、`session_id`、`content`、`integrated_at`。
- `memory_relationship_extractions`：在 Work 字段之外增加 `character_name`。

`memory_jobs.kind` 固定为：

```text
work_extraction
relationship_extraction
work_consolidation
relationship_consolidation
work_maintenance
relationship_maintenance
```

状态固定为 `pending | running | completed | failed`。没有取消、重试、心跳、租约、路径锁或手动 Job 接口。

## 调度

- Turn 完成后立即创建两轨 Extraction Job；每轨并发为 2，互不等待。
- 单轨未整合结果达到 8 条，或最老结果等待 6 小时，创建该轨 Consolidation Job。
- Consolidation 一次最多冻结 256 条结果；成功后只把实际送入 LLM 的 `consumedTurnIds` 标为已整合。
- Server 每小时检查少量待整合结果是否超时。
- Server 每 12 小时尝试一次两轨 Maintenance；同轨正在等待或执行 Consolidation 时跳过，不创建空 Job。
- 同轨 Consolidation 与 Maintenance 串行；不同轨可以并行；Extraction 只写 SQL，可与文件任务并行。

Server HTTP ready 后调用 Memory Composition 的 `start()`，恢复上次遗留的 `running` Job 为 `pending`，再启动现有队列和定时器。关闭时一个 `AbortSignal` 停止领取新任务并中止在途 LLM；不恢复已断开的网络请求，也不建立额外恢复协议。

## Consolidation 输出

整合 LLM 返回文件操作数组：

```json
[
  { "path": "MEMORY.md", "operation": "write", "content": "..." },
  { "path": "topics/old.md", "operation": "delete" }
]
```

Memory 包在真实外部边界校验 JSON、操作类型和轨道内路径。Work 只能修改 `MEMORY.md`、`memory_summary.md` 与 `topics/*.md`；Relationship 只能修改固定根文件和当前批次已有 `character_name` 对应的目录。

`consumedTurnIds` 由本地输入打包过程产生，不由 LLM 返回。文件修改、Git 基线更新和 SQL 整合标记按此顺序执行，避免先丢掉尚未写入文件的结果。

## Maintenance 与容量

- Work Maintenance：移除临时 diff 文件并压缩本轨 Git 基线存储。
- Relationship Maintenance：另外按每个角色最近 180 个活跃日期保留 history。
- 容量状态由 `evaluateMemoryCapacity` 返回；上限 1 GiB，80% 起进入 warning。

达到上限不会猜测用户愿意删除哪份正式记忆。当前容量只展示，不阻断 Memory 运行。

## Server HTTP 边界

```text
GET  /api/memory/files
GET  /api/memory/files/content
POST /api/memory/files/search
GET  /api/memory/jobs
GET  /api/memory/jobs/history
GET  /api/memory/stats
```

Files 只读。`/jobs` 返回 pending、running 与 failed；`/jobs/history` 返回最近最多 100 条 completed/failed 终态记录。

`/stats` 另外返回 `rootPath`，只供 Desktop 的“打开 Memory 文件夹”按钮消费；`/files/content` 返回所读文件的 `absolutePath`，只供 Tauri 在文件管理器中定位。Memory Tool 仍只拿相对路径和正文。

## Agent 能力边界

根 Agent 只获得 Memory List、Search、Read 三种工具。子 Agent 不获得 Memory 能力。Memory Note、文件写入、手动提取、手动整合、手动维护和清空接口均不存在。
