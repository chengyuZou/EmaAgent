# Backup

Backup 只负责导出和导入单个 Session。角色、Provider 配置、MCP、Skill、Knowledge Base 原文和整机数据不属于当前备份范围。

## 归档内容

一个 `.ema-session.zip` 包含：

- `manifest.json`：格式版本、Session id、导出时缺失的文件；
- `records/session.json`：Session 本身；
- `records/*.jsonl`：Turn、Message、Task、AgentRun、Tool 执行、后台进程、附件、语音、用量和 KB 使用记录；
- `files/`：附件、TTS 成品、TTS 片段和后台进程输出。

导出在一个 SQLite 读取事务中依次读取数据库行并写入临时 JSONL，文件复制在事务结束后进行。最终 ZIP 逐块压缩并写入调用方提供的输出，不把整个 Session 或 ZIP 放进内存。

导入逐块解压到 `<dataDir>/.backup-temp/imports`，只检查归档路径、条目数量、展开体积和压缩比。记录通过当前格式校验后，文件先排他发布到目标 Session 目录，数据库随后在一个事务中恢复；数据库失败时删除本次发布的整个 Session 目录。

## 断电与取消

- 导出或导入失败后，本次临时目录会立即删除；
- 软件下次启动构造 `SessionBackup` 时，会清空上次异常退出遗留的 `.backup-temp`；
- 不续传、不续压缩，失败后整次重来；
- 来源机尚未结束的 Turn、AgentRun、Tool 执行和后台进程在导入时转成明确终态，不会自动继续。

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
