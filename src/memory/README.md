# @ema-agent/memory

`@ema-agent/memory` 负责 EmaAgent 的本地文件式长期记忆。它不保存 Turn 副本，也不允许 Agent 或前端直接写正式记忆；原始对话事实保留在 Session/Turn SQL，Memory 只保存自动提取和整合后的长期内容。

## 两条独立轨道

- Work：全局共享，记录稳定的工作偏好、习惯、协作方式和长期约束。
- Relationship：全局共享用户关系信息，并按 `character_name` 保存角色关系信息。

两轨共用 `memory-llm` 模型绑定，但各自拥有独立的 Extraction、Consolidation、Maintenance Job、SQL 提取结果和文件目录。Relationship Turn 没有 `character_name` 时不创建提取任务。

## 文件目录

默认保存在用户主目录下的 `.ema-agent/memories`. 设置 `EMA_PROFILE_DIR` 时改用 `<EMA_PROFILE_DIR>/memories`, 与 Desktop 和 Server 的应用数据目录一致.

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
   ├─ characters/<character_name>/
   │  ├─ MEMORY.md
   │  └─ history/
   └─ .git/
```

Work 没有 `history/`。Work 的 `memory_summary.md` 供 Turn 开始时注入，不进入 Memory List/Search/Read 的可读文件集合。Relationship 不生成摘要；Turn 读取 `shared_user_memory.md`、当前角色的 `MEMORY.md` 全文，以及 `character_relations.md` 中标题或正文含当前角色名的完整 `##` 段落。Relationship history 仅按需读取。正式 Markdown 可由用户在文件管理器中直接修改；下一次整合通过各轨 Git diff 读取这些修改。

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

状态固定为 `pending | running | completed | failed`. 没有手动启动或重试 Job 的接口. `memory_jobs.reminder_ignored` 只记录失败提醒是否被用户忽略, 不改变任务状态、错误或提取内容. 新失败任务默认未忽略.

任务完成与写入正式记忆是不同的事实:

| 后端结果 | 展示含义 |
| --- | --- |
| Extraction 完成, 没有提取表记录 | 没有可保存内容 |
| 有提取记录, `integrated_at` 为空 | 提取内容已保存, 等待整理 |
| 有提取记录, `integrated_at` 非空 | 提取内容已参与整合, 不表示每句话都写入正式记忆 |
| Consolidation 完成 | 整合完成 |
| Maintenance 完成 | 维护完成 |

列表只读取状态、结果标签、时间、角色名和忽略标记. 错误与提取正文在展开详情时单独读取, 不随每次列表刷新传输.

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

Memory 包在真实外部边界校验 JSON、操作类型和轨道内路径。Work 只能修改 `MEMORY.md`、`memory_summary.md` 与 `topics/*.md`；Relationship 只能修改 `shared_user_memory.md`、`character_relations.md` 和当前批次已有 `character_name` 对应的目录，不接受 `memory_summary.md`。

`consumedTurnIds` 由本地输入打包过程产生，不由 LLM 返回。文件修改、Git 基线更新和 SQL 整合标记按此顺序执行，避免先丢掉尚未写入文件的结果。

Server 调用 LLM 时, Extraction 的输出上限为 4,096 tokens, 两轨 Consolidation 为 16,384 tokens. Anthropic 和 OpenAI 兼容协议都收到明确的 `maxOutputTokens`. 若模型以 `max_tokens` 结束, 本次调用失败, 不把截断内容交给后续提取或文件操作解析. 有响应的失败调用仍记录其真实用量.

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
GET  /api/memory/overview
GET  /api/memory/jobs
GET  /api/memory/jobs/recent
GET  /api/memory/jobs/:id
POST /api/memory/jobs/:id/ignore
POST /api/memory/jobs/ignore-all
GET  /api/memory/stats
```

Files 与 Overview 只读. `/overview` 返回最近修改的 5 份非空正式 Markdown 文件的开头, 不限定轨道或当前角色. 选择文件时只读取目录和文件属性; 每份正文最多读取 2 KiB 就关闭文件, 不先加载完整正文. 返回 `path`、`content` 和 `truncated`, UTF-8 截断不会产生半个字符. `.git`、临时 diff 和 Work 的注入摘要不作为正式预览.

`/jobs/recent` 返回最新 3 条 SQL 任务记录, 不按 Turn 合并. `/jobs` 按 `created_at`、`id` 排序, 每页 6 条, 支持:

- `startAt`、`endAt`: 毫秒时间戳, 范围包含起点、不包含终点.
- `order`: `asc` 或 `desc`.
- `page`: 从 1 开始. 请求超出最后一页时返回最后一页.
- `cursorCreatedAt`、`cursorId`、`cursorDirection`: 三个字段一起传入, 用于相邻的 `next` 或 `previous` 翻页. SQL 表不保存游标列.

直接跳到尚未访问的页时, 先查询该页前一条记录的排序键, 再读取当页任务. 此时仍需要跳过前面的索引项, 但不加载这些任务的正文. 相邻翻页使用返回的 `previousCursor`、`nextCursor`. `unignoredFailureCount` 针对全部失败提醒, 不受日期或当前页限制.

忽略接口成功返回 HTTP 204. Desktop 随后重新读取列表; 单项忽略只接受失败任务, 全部忽略只更新当时尚未忽略的失败记录. 它们不删除任务、不自动重试, 后续的新失败仍需提醒.

`/stats` 另外返回 `rootPath`, 供 Desktop 文件栏的打开文件夹操作消费; `/files/content` 返回所读文件的 `absolutePath`, 供 Tauri 在文件管理器中定位. Memory Tool 仍只拿相对路径和正文.

## Desktop 展示与刷新

Memory 保留概览、文件和后台任务三个入口. 概览的正式预览、最近任务和容量是独立请求, 哪一项返回就先显示哪一项. 预览和容量每 30 秒刷新, 最近任务与后台任务列表每 5 秒刷新. 一次请求结束后才安排下一次, 慢查询不会重复并行发出.

离开对应 Memory 页面、回到聊天、隐藏或最小化 main 时, 停止页面读取与定时器. 返回时重新读取. 已提交的忽略操作继续完成, 不因离开页面取消. 页面状态只留在组件中, 不建立 Memory 全局 Store; 正文与容量的相同字段不会因为任务列表刷新而重复渲染.

后台任务默认今天、最新在前. 日期选项还包括昨天、近 7 天、近 30 天、本月、上月与全部, 由浏览器本地日历计算范围. 相邻分页使用游标, 页码按钮或输入页码支持直接跳转. 时间显示到 `YYYY/MM/DD HH:mm`. 展开详情与容量变化有局部过渡, 定时刷新不重复播放列表入场动画; 减少动态效果设置会关闭这些动画.

## 验证入口

- `src/memory/tests/memoryFiles.test.ts`: 有界预览、UTF-8 截断、目录筛选与取消.
- `src/storage/tests/repos/memory.integration.test.ts`: 结果标签、忽略持久化、日期与游标分页.
- `apps/server/tests/memoryRoutes.test.ts`: 真实临时数据库上的 HTTP 请求, 以及两种 LLM 协议的实际输出上限和截断响应.

## Agent 能力边界

根 Agent 只获得 Memory List、Search、Read 三种工具。子 Agent 不获得 Memory 能力。Memory Note、文件写入、手动提取、手动整合、手动维护和清空接口均不存在。
