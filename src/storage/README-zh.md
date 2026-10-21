# Storage

[English](./README.md)

这个包打开应用使用的 SQLite 数据库, 并通过 Repository 读写表中的记录. 宿主提供路径, 执行迁移, 再把对应的连接交给 Repository.

## 打开数据库

```ts
import { Database, SessionsRepo } from '@ema-agent/storage';

const database = new Database({ path: dataDatabasePath, kind: 'data' });
try {
  database.migrate();
  const sessions = new SessionsRepo(database.sqlite);
  const session = sessions.findById(sessionId);
} finally {
  database.close();
}
```

打开文件前先创建父目录. 测试可以传 `{ memory: true, kind: 'data' }`. `migrate()` 成功后同一实例不会重复迁移, `close()` 可以重复调用.

| Kind | 常用位置 | 保存内容 |
| --- | --- | --- |
| `profile` | `~/.ema-agent/profile.db` | Provider, 模型及绑定, 设置, 角色和资源信息, Skills, MCP 配置和市场缓存 |
| `data` | `~/.ema-agent/data/data.db` | Session, Turn, Message, Task, Goal, 子 Agent 和 Run, 工具执行, 后台命令, 附件和语音记录, 用量, Memory 任务及提取结果 |
| `narrative` | `~/.ema-agent/narrative/narrative.db` | 三个固定周目的剧情块, 实体, 关系及向量 |

这些路径由宿主约定, 不是 `Database` 自行选择. 附件正文, 音频, 角色资源和正式 Memory 正文保存在文件中, Repository 记录查找和管理它们需要的路径, 索引及状态.

文件连接启用 WAL, 外键, 5 秒 busy timeout 和 `synchronous = NORMAL`. NORMAL 模式下, 断电可能丢失最近尚未同步的已提交事务. data 连接要求 FTS5, 并注册检索触发器使用的正文提取和分词函数.

## 文件位置

`@ema-agent/storage/dataPaths` 是独立的 Node 路径计算入口. 导入它不会打开 SQLite 或创建文件. Server 提供当前数据目录, `dataResourceDir`, `sessionResourceDir` 和 `turnResourceDir` 供写入, 读取, 备份与清理使用同一套位置规则.

会话资源位于该目录下的 `attachments/<sessionId>/{images,pasted}/`, `audio/<sessionId>/<turnId>/`, `web-fetch/<sessionId>/`, `tool-results/<sessionId>/`, `background-processes/<sessionId>/<processId>/` 和 `scratchpad/<sessionId>/<turnId>/`. 子代理使用所属 Session 的资源目录, 身份与历史仍保存在数据库. 备份暂存使用 `.backup-temp/`, 不属于 Session 资源.

业务写入时按需创建目录. Server 删除 Session 时清理各类资源, 启动时回收导入中断留下的孤儿目录. 不在原地迁移旧的 Session 优先布局. 重置前应把现有数据完整保存在当前数据目录之外; 通过 Session 归档将支持的记录和文件恢复到当前布局.

## 读写及所属关系

Repository 使用 SQL 参数绑定和明确的行类型. 许多行保留 `session_id` 这样的 SQL 字段名及 null, 业务 Store 再转换成对外类型. 从包根入口导入 Repository 和共享行类型.

外键, 唯一索引和所属关系触发器会拒绝错误关联. 方法需要同时修改多个关联记录且约定全部成功或全部失败时, 使用事务. 这是数据库内的保证, 不代表其他包写入的文件也能一起回滚.

- `ProvidersRepo.save()` 在事务内替换 Provider 的能力和协议配置. 删除能力会级联删除对应模型. `ProviderModelsRepo.save()` 更新模型信息时保留已有启用选择, 启停由 `setEnabled()` 修改.
- `SettingsRepo.read()` 区分缺失, 有效值和损坏的 JSON. `setMany()` 在开始事务前先序列化全部值.
- Task, 工具执行和后台进程按保存的版本或当前状态更新. 迟到的旧结果不能覆盖较新的执行.
- `createSqliteIdBatches()` 去重 ID, 再结合连接的参数限制, 预留参数和包内批次上限拆分查询.

## 历史与检索

`MessagesRepo.listPage()` 加载完整消息. 消息目录用 `listHeadersPage()`, 展开某条正文时用 `findById()`. 分页使用 `(createdAt, id)` 游标, 不使用消息序号. 顺序以各方法声明为准.

发给模型的有效历史从最新保存的摘要开始. 查询沿摘要覆盖关系找到原始截止位置, 再追加后面的消息, 不改写保存的原消息. 主 Session 历史有读取上限, 子 Agent 使用自己的历史查询和限制.

普通消息由 SQLite 触发器维护检索索引. 中文优先使用原生 Jieba 依赖分词, 不可用时使用按字符和单词拆分的实现. FTS 查询将词作为字面值引用后用 OR 连接. 标题及后备正文查询会转义 LIKE 通配符, 不把用户文字当成 SQL 模式.

`SessionsRepo.fork()` 复制选定的对话记录并替换 ID, 不复制附件文件或索引. 消息块仍可能引用源 Session 的文件, 删除源文件后这些引用可能失效. 用户流程见 [Session](../session/README-zh.md).

## 子 Agent, 任务和文件记录

`subagents` 保存稳定身份, `subagent_runs` 保存一次执行. 首次身份和 Run 由调用方在同一事务中插入. 后续执行通过 `SubagentRunsRepo.startRun()` 在内部事务中创建并更新身份. 唯一索引限制同一身份最多一个 running Run, 完成时也只更新对应的 running Run.

fork 前缀消息的 `run_id` 为 null, 保留原始生成来源. 子 Agent 自己的 Assistant 消息从所属 Run 查询来源. 身份列表, Run 历史和消息分页分别读取, 打开列表不需要加载全部正文及执行结果.

`MemoryRepo` 在 data 数据库保存提取和整理任务. 领取任务, 完成任务以及标记明确消费的提取结果使用 SQL 事务. 正式文件由 [Memory](../memory/README-zh.md) 更新.

`speech_outputs` 以正式 WAV 文件路径为主键, 要求保存字节数和毫秒时长. 一个 Turn 可以有多个角色版本, 同路径重新生成只替换对应记录. `listPage()` 返回 Turn 级汇总, 包括没有音频的 Turn; `listForTurn()` 加载具体文件. 附件记录同样指向单独管理的文件.

`SessionBackupReader` 在一个同步事务的回调中提供可迭代记录, 必须在回调内消费. `SessionBackupRestorer` 按依赖顺序插入, 检查外键, 清除不可用的项目及源 Session 引用. 归档校验, ID 替换和文件放置见 [Backup](../backup/README-zh.md).

## 数据迁移

Profile 与 Data 分别通过各自唯一的 `001_initial.sql` 独立初始化, 数据库版本为 1. Profile 直接预置国内站 `siliconflow-cn` 和 `moonshotai-cn` 及同名目录 ID, 同时预置 DeepSeek 的 LLM 和 Vision 能力. 凭据, 模型和绑定在初始化后配置. Data 初始化不读取 Profile.

应用的 `0.1.0` 等版本号不决定数据库版本. 每份编号 SQL 与其 `user_version` 更新处于同一事务. 已执行的版本会跳过, 失败只回滚本文件的 SQL 和版本更新. 编号缺失或数据库版本比当前 SQL 更新时直接报错. 标有 `-- ema:migration foreign_keys=off` 的迁移在事务外临时关闭外键, 提交前检查关联关系.

当前 Alpha 基线要求使用全新数据库, 不自动转换或降级此前的开发数据库, 也不把旧凭据或会话复制进新基线. 重置前应备份现有应用数据. 正式发布后的数据库升级应追加连续编号文件, 不再修改已经应用的基线.

Narrative 初始化在事务内安装表结构和三份剧情数据. 读取器分批执行种子 SQL, 不把所有种子文件读进一个字符串. Narrative Repository 按固定周目 ID 返回向量 Buffer 或原文, 检索流程见 [Narrative](../narrative/README-zh.md).

`build` 会把 SQL 复制到 `dist/migrations`, 正式发布不能只带编译后的 JavaScript.

可选迁移 CLI 与宿主一样读取 `EMA_PROFILE_DIR`, 未设置时使用 `~/.ema-agent`. 它打开 `<profile>/profile.db` 和 `<profile>/data/data.db`. `--data-dir <directory>` 只改变后者. 即使 `--status` 也会创建目录和打开数据库. 对真实数据运行前先确认目标并备份.

## 阅读和验证

从 `database/database.ts` 与 `database/migrationsRunner.ts` 开始, 再看 `repos/profile`, `repos/data` 或 `repos/narrative` 下的对应 Repository. 具体何时保存由对应业务包说明, `search/` 包含消息索引和查询准备.

```bash
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/storage typecheck
pnpm --filter @ema-agent/storage build
```

测试使用临时或内存数据库, 检查迁移, 所属关系, 分页, 检索, 状态更新及关联记录恢复.
