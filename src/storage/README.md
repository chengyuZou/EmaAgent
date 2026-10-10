# @ema-agent/storage

EmaAgent 的 SQLite 数据访问层。使用 `better-sqlite3` 和手写参数化 SQL，不承载业务编排、HTTP Route、模型调用或文件资源生命周期。

## 目录

```text
src/storage/
├─ database/                  SQLite 连接、迁移执行器、迁移 CLI 与批量 ID 工具
├─ migrations/
│  ├─ profile/               全局配置与用户资产表结构
│  └─ data/                  Session 与运行记录表结构
├─ repos/
│  ├─ profile/               只访问 profile.db 的 Repo
│  └─ data/                  只访问 data.db 的 Repo
├─ search/                   FTS、中文分词与 LIKE 转义
├─ tests/                    迁移、Repo 与数据库行为测试
└─ index.ts                  对其他业务包提供的统一公共出口
```

目录按数据库归属分组，而不是为每张表建立一层文件夹。开发者看到 Repo 的路径，就能先判断它应由哪个数据库实例装配。

## 两个数据库

| 数据库 | 默认位置 | 负责内容 |
|---|---|---|
| `profile.db` | `~/.ema-agent/profile.db` | Provider、模型绑定、角色、设置、Skill、权限规则、全局 Memory |
| `data.db` | `~/.ema-agent/data/data.db`，也可切换数据目录 | Session、Turn、Message、附件索引、Task、Goal、Subagent、ToolExecution、后台进程与 Session 级状态 |

`Database` 只负责打开某一个 SQLite 文件、设置 pragma、执行对应迁移和暴露受控句柄。业务装配层负责把正确的数据库实例交给正确的 Repo。

## 数据访问边界

- Repo 只做 SQL 查询、行映射和数据库自身能保证的约束，不调用 LLM、Tool、Memory Pipeline 或 HTTP。
- 已知字段使用明确 SQL column 和 TypeScript 类型；不能用万能 JSON 隐藏稳定业务字段。
- SQL 参数必须使用占位符绑定，不能把用户输入拼进 SQL 字符串。
- 涉及多张表且要求“要么全成功、要么全失败”的操作使用单个 SQLite transaction。
- 文件正文、Live2D、图片、音频和大型结果不写入 SQLite；数据库只保存受控路径、摘要、状态或索引。
- 业务包默认从 `@ema-agent/storage` 根出口导入，避免依赖内部目录结构。Storage 自己的测试可以直接导入具体 Repo。
- `MessagesRepo.listPage()` 返回 History 所需的完整 Message；只做目录展示时使用
  `listHeadersPage()`，正文由明确的 Message id 再经 `findById()` 读取，不能让大块
  `blocks_json` 跟随折叠目录批量穿过 HTTP 边界。
- `GoalsRepo.listSummariesForSession()` 只选择 Goal 历史列表的身份, 正文, 状态, 终态原因和时间列, 不批量读取 feedback/error/version. 完整详情通过 `findById()` 读取, Row 到业务 Goal/GoalSummary 的映射由 GoalStore 负责.

## 语音文件记录

`speech_outputs` 按 Turn 保存一份正式 WAV 的 Session、受管路径、`audio/wav`、字节数、毫秒时长和创建时间. 正常完成和取消后保留的文件使用同一结构, 不记录逐句片段或 pending 文件. Speech 完成文件后由 Server 写入记录, Storage 不负责写音频或等待播放; 统计和 Session Backup 读取这些正式记录.

当前开发基线的语音表要求真实时长, 没有分段计数字段. 修改基线不会改变已经执行过该迁移的开发数据库, 代码不会自动清空或补写旧库. 使用新契约前需要由使用者决定何时重建开发库.

## 子代理持久化

子代理使用三张表, 分别由三个 Repo 负责:

- `subagents` 保存稳定身份: `id`、所属 `session_id`、Title、description、创建/更新时间、最近实际 Permission、Provider/Model/协议、思考强度和状态. 不保存角色 Prompt、`latest_run_id`、执行统计或最终结果. 新建必须提供 Title 和 description, 旧行缺失的配置保持 null.
- `subagent_runs` 保存一次执行: 独立 RunId、所属子代理、父 `parent_tool_call_id`、`context_mode`、描述、实际配置、状态、结果和本次统计. 耗时由 `completed_at - created_at` 取得, 不另存 `duration_ms`. `context_mode` 仅为 `subagent` 或 `fork`; 继续历史不是第三种模式.
- `subagent_messages` 复用普通 Message 的正文、kind、role、中断标记与摘要字段. 按 `created_at, id` 排序和游标分页, 不使用 sequence. fork 从父 Session 复制来的消息不属于子代理自己的任何一次 Run, 所以 `run_id` 为 null; 其中 Assistant 另存原生成来源, 自身 Assistant 则从所属 Run 查询来源.

首次新建使用 `SubagentsRepo.insert(subagent)` 和 `SubagentRunsRepo.insert(run)`, 两者各自只插入本表, 返回插入行, 不持有事务或相互调用; SQL 约束错误直接抛出. `SubagentStore.start()` 在业务层用同一 SQLite 连接的外层事务组合它们, 防止只留下身份而没有首个 Run.

复用已有身份不走首次两个 insert, 使用 `SubagentRunsRepo.startRun()`. 它持有一次内部事务, 新增 Run 并更新身份状态/时间, 仅显式提供时修改 Title/description. SQL 唯一索引限制同一子代理最多一个 running Run, 忙碌时返回 undefined 且不改身份, 其他约束错误不吞掉. 实际配置和状态更新与身份行在同一事务内提交. 完成、失败、取消均按 RunId 修改仍为 running 的记录, 不会把旧执行的迟到结果写入新执行. 最近配置如何选用由执行装配方决定, Repo 不替调用方指定默认配置.

`SubagentsRepo.listForSession()` 直接返回身份行, 按 `updated_at DESC, id DESC` 游标分页, 不派生 Summary 或加载 Run 统计. `SubagentRunsRepo.listForSubagent()` 返回 `{ items, nextCursor }`, 按 `created_at DESC, id DESC` 游标分页; Run Cursor 为 `{ createdAt, id }`. `findById()` 读取单次完整执行. `findLatestRun()` 则按创建时间和实际插入顺序判断最近一次执行, 不用随机 ID 大小推断先后.

`SubagentMessagesRepo.insertMany()` 原子写入首次前缀与任务; `listAllForSubagent()` 用于完整历史, `listPage()` 用于分页展示, `listForSubagentFromSummary()` 返回最新摘要与覆盖截止点之后的有效消息, 用于继续会话.

fork 只复制父请求的有效固定前缀, 为每条消息生成子代理内的新 ID. 摘要覆盖 ID 在副本内时重新映射, 不在时保存 null, 重放以该摘要自身位置为边界; 不为补齐覆盖 ID 额外复制已压缩的旧历史. 摘要正文和 savedTokens 始终保留.

`SessionBackupReader/Restorer` 导出和恢复身份、Run 与原始消息行, 不把查询派生的模型来源重复写入消息. Run 依创建时间和插入顺序导出, 恢复时先写 Run 再写 Message, 保持外键与同毫秒执行顺序. 外部 Backup 包的归档协议由该包另行接线.

## 迁移规则

两个数据库分别读取 `migrations/profile` 和 `migrations/data`，各自使用 SQLite `user_version` 推进。

```text
001_initial.sql
002_add_xxx.sql
003_remove_yyy.sql
```

- 迁移按三位数字连续编号；缺号会直接报错。
- 每个迁移和 `user_version` 更新处于同一事务，断电后不会留下已改表但未记版本的半状态。
- 当前 `001_initial.sql` 是开发基线; 修改基线不会自动升级已经初始化的开发库, 需要重建时先备份并由使用者决定执行时间.
- 已经发布的迁移只追加, 不修改历史文件, 也不重新编号.
- 未来若再次压缩迁移历史，应单独建立 baseline/checksum 方案，不能直接删除旧文件让已有数据库静默漂移。
- 数据库版本高于当前代码支持的最新版本时 fail-closed，防止旧程序误读新 Schema。

常用命令：

```bash
pnpm --filter @ema-agent/storage migrate
pnpm --filter @ema-agent/storage migrate:status
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/storage build
```

`--data-dir` 只覆盖 `data.db` 所在目录；`profile.db` 仍位于用户的 `.ema-agent` 目录。

## 新增或修改 Repo

1. 先确认字段属于 `profile` 还是 `data`，再选择对应迁移目录与 Repo 目录。
2. Schema 变化新增迁移文件；不要依赖 Repo 在运行时偷偷补列。
3. Repo 返回稳定、明确的行类型，数据库命名与业务命名的转换集中在 Repo 内。
4. 更新根 `index.ts` 的必要公共出口；不要把仅供 Storage 内部使用的 helper 暴露出去。
5. 验证至少覆盖迁移可执行、关键约束和本次修改的查询行为。

Storage 是持久化地基，不是业务服务层。是否允许删除、何时重试、怎样恢复 Turn、怎样展示错误等规则由对应业务模块决定；Storage 只提供足够清晰且可事务化的数据操作。
