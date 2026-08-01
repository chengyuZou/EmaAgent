# @ema-agent/storage

EmaAgent 的 SQLite 数据访问层。使用 `better-sqlite3` 和手写参数化 SQL，不承载业务编排、HTTP Route、模型调用或文件资源生命周期。

## 目录

```text
src/storage/
├─ database/                  SQLite 连接、迁移执行器、迁移 CLI 与批量 ID 工具
├─ migrations/
│  ├─ profile/               全局配置与用户资产表结构
│  ├─ data/                  Session 与运行记录表结构
│  └─ kb/                    单个 Knowledge Base 的表结构
├─ repos/
│  ├─ profile/               只访问 profile.db 的 Repo
│  ├─ data/                  只访问 data.db 的 Repo
│  └─ kb/                    只访问 kb.db 的 Repo
├─ search/                   FTS、中文分词与 LIKE 转义
├─ tests/                    迁移、Repo 与数据库行为测试
└─ index.ts                  对其他业务包提供的统一公共出口
```

目录按数据库归属分组，而不是为每张表建立一层文件夹。开发者看到 Repo 的路径，就能先判断它应由哪个数据库实例装配。

## 三个数据库

| 数据库 | 默认位置 | 负责内容 |
|---|---|---|
| `profile.db` | `~/.ema-agent/profile.db` | Provider、模型绑定、角色、设置、Skill、权限规则、全局 Memory 与 KB 注册信息 |
| `data.db` | `~/.ema-agent/data/data.db`，也可切换数据目录 | Session、Turn、Message、附件索引、Task、AgentRun、ToolExecution、后台进程与 Session 级状态 |
| `kb.db` | 每个 KB 自己的受控目录 | 文档、分块、预览、FTS、导入与重嵌入任务 |

`Database` 只负责打开某一个 SQLite 文件、设置 pragma、执行对应迁移和暴露受控句柄。业务装配层负责把正确的数据库实例交给正确的 Repo。

## 数据访问边界

- Repo 只做 SQL 查询、行映射和数据库自身能保证的约束，不调用 LLM、Tool、Memory Pipeline 或 HTTP。
- 已知字段使用明确 SQL column 和 TypeScript 类型；不能用万能 JSON 隐藏稳定业务字段。
- SQL 参数必须使用占位符绑定，不能把用户输入拼进 SQL 字符串。
- 涉及多张表且要求“要么全成功、要么全失败”的操作使用单个 SQLite transaction。
- 文件正文、Live2D、图片、音频和大型结果不写入 SQLite；数据库只保存受控路径、摘要、状态或索引。
- 业务包默认从 `@ema-agent/storage` 根出口导入，避免依赖内部目录结构。Storage 自己的测试可以直接导入具体 Repo。

## 迁移规则

三个数据库分别读取 `migrations/profile`、`migrations/data` 和 `migrations/kb`，各自使用 SQLite `user_version` 推进。

```text
001_initial.sql
002_add_xxx.sql
003_remove_yyy.sql
```

- 迁移按三位数字连续编号；缺号会直接报错。
- 每个迁移和 `user_version` 更新处于同一事务，断电后不会留下已改表但未记版本的半状态。
- 当前 `001_initial.sql` 是 2026-08-01 首次公开内测前冻结的开发基线；此前的本地开发数据库需要备份后重建。
- 从该基线开始，已经发布的迁移只追加，不修改历史文件，也不重新编号。
- 未来若再次压缩迁移历史，应单独建立 baseline/checksum 方案，不能直接删除旧文件让已有数据库静默漂移。
- 数据库版本高于当前代码支持的最新版本时 fail-closed，防止旧程序误读新 Schema。

常用命令：

```bash
pnpm --filter @ema-agent/storage migrate
pnpm --filter @ema-agent/storage migrate:status
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/storage build
```

`--data-dir` 只覆盖 `data.db` 所在目录；`profile.db` 仍位于用户的 `.ema-agent` 目录。KB 数据库由 Knowledge Base 装配流程按具体 KB 路径创建。

## 新增或修改 Repo

1. 先确认字段属于 `profile`、`data` 还是 `kb`，再选择对应迁移目录与 Repo 目录。
2. Schema 变化新增迁移文件；不要依赖 Repo 在运行时偷偷补列。
3. Repo 返回稳定、明确的行类型，数据库命名与业务命名的转换集中在 Repo 内。
4. 更新根 `index.ts` 的必要公共出口；不要把仅供 Storage 内部使用的 helper 暴露出去。
5. 验证至少覆盖迁移可执行、关键约束和本次修改的查询行为。

Storage 是持久化地基，不是业务服务层。是否允许删除、何时重试、怎样恢复 Turn、怎样展示错误等规则由对应业务模块决定；Storage 只提供足够清晰且可事务化的数据操作。
