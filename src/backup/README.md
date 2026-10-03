# Backup

Backup 只负责导出和导入单个 Session。角色、Provider 配置、MCP、Skill、Knowledge Base 原文和整机数据不属于当前备份范围。

## 归档内容

一个 `.ema-session.zip` 包含：

- `manifest.json`：格式版本、Session id、导出时缺失的文件；
- `records/session.json`：Session 本身；
- `records/*.jsonl`：Turn、Message、Task、Goal、Subagent 身份、Subagent Run、子 Message、Tool 执行、后台进程、附件、语音和用量记录；
- `files/`：附件、TTS 成品、TTS 片段和后台进程输出。

当前格式为 v7, 只接受 v7. v5/v6 归档返回 `unsupported_version`, 不做旧字段转换或补造 Run.

子代理使用 `subagents.jsonl`、`subagentRuns.jsonl`、`subagentMessages.jsonl` 三份记录. 身份只保留 Title、description、最近实际配置和状态; 每次 Run 保存自己的配置、结果及统计. fork 从父 Session 复制来的消息保留 `runId=null` 和原 Assistant 的模型来源; 子代理自身输出的原始来源列仍为空, 通过所属 Run 读取, 不重复保存派生值. 摘要覆盖 ID、savedTokens 和原生消息块一并保留, 不保留旧 sequence.

导出在一个 SQLite 读取事务中依次读取数据库行并写入临时 JSONL，文件复制在事务结束后进行。最终 ZIP 逐块压缩并写入调用方提供的输出，不把整个 Session 或 ZIP 放进内存。

导入逐块解压到 `<dataDir>/.backup-temp/imports`, 写盘前检查路径越界和重名, 总展开体积限制为 8 GiB. 解包后先校验 manifest 版本, 再检查 v7 文件清单和记录结构, 避免旧记录文件抢先造成格式错误. 子消息的 Run 和摘要覆盖游标必须属于同一个子代理. 记录校验通过后, 文件先排他发布到目标 Session 目录, 数据库随后在一个事务中恢复; 数据库失败时删除本次发布的整个 Session 目录. 根消息和 fork 子消息中的受管附件路径一起改为目标数据目录, 用户外部文件引用不变.

## 断电与取消

- 导出或导入失败后，本次临时目录会立即删除；
- 软件下次启动构造 `SessionBackup` 时，会清空上次异常退出遗留的 `.backup-temp`；
- 不续传、不续压缩，失败后整次重来；
- 来源机尚未结束的 Turn、Subagent 身份和 Run、Tool 执行及后台进程在导入时转成明确终态, 不会自动继续; running 子代理身份及 Run 转为 cancelled, Run 记录中断原因和结束时间. active Goal 则变为 paused, 保留原目标和反馈, 等待用户手动激活.

## 公共入口

```ts
const backup = new SessionBackup(
  activeDataDir,
  sessionBackupReader,
  sessionBackupRestorer,
  modelSelectionExists,
);

const sessionExport = backup.exportSession(sessionId, signal);
await sessionExport?.writeTo(output);

const result = await backup.importSession(source, signal);
```

`BackupArchiveSource` 和 `BackupOutput` 只描述跨进程流式输入输出。HTTP、文件选择器和前端下载行为由应用层适配，不进入本包。
