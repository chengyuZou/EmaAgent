# Backup

Backup 只负责导出和导入单个 Session。角色、Provider 配置、MCP、Skill 和整机数据不属于当前备份范围。

会话文件夹只包含资源, 消息等记录在共用的 `data.db` 中. 因此先把这个 Session 的记录和资源写入临时目录, 再将目录路径交给压缩库; 仅压缩会话文件夹不能得到完整会话.

## 归档内容

一个 `.ema-session.zip` 包含：

- `manifest.json`: Session ID 和导出时未包含的文件;
- `records/session.json`：Session 本身；
- `records/*.jsonl`：Turn、Message、Task、Goal、Subagent 身份、Subagent Run、子 Message、Tool 执行、后台进程、附件、语音和用量记录；
- `files/`: 附件、正式 WAV 和后台进程输出.

记录使用当前业务数据结构, 没有备份版本号或旧字段转换. 导入必须通过当前文件清单、字段和记录关联的校验; 字段发生变化后, 不保证先前导出的 ZIP 仍可导入. Session 的权限、TTS、模型和推理强度按现有业务语义保存.

`records` 保存导入字段校验、数据库行转换和固定文件路径. 数据库行类型来自 Storage; JSONL 中的字段校验用于读取所选 ZIP, 不能由 TypeScript 类型检查代替. 这些代码不负责 ZIP 压缩或解压.

语音记录保存 `audio/wav`、文件大小和必填毫秒时长, 每个 Turn 可以有多个角色版本. ZIP 内路径为 `files/speechOutputs/<turnId>/<turnId>-<characterName>.wav`, 恢复时位于 `sessions/<sessionId>/audio/<turnId>/<turnId>-<characterName>.wav`, 与 Speech 读取使用同一条规则. 角色名保留在规范文件名中, 不新增数据库角色列. 正常完成和自动生成取消后保留的音频都可以导出; pending 文件没有正式记录, 不进入备份.

子代理使用 `subagents.jsonl`、`subagentRuns.jsonl`、`subagentMessages.jsonl` 三份记录. 身份只保留 Title、description、最近实际配置和状态; 每次 Run 保存自己的配置、结果及统计. fork 从父 Session 复制来的消息保留 `runId=null` 和原 Assistant 的模型来源; 子代理自身输出的原始来源列仍为空, 通过所属 Run 读取, 不重复保存派生值. 摘要覆盖 ID、savedTokens 和原生消息块一并保留, 不保留旧 sequence.

## 导出和导入

导出在一个 SQLite 读取事务中依次读取数据库行, 写入 `<dataDir>/.backup-temp/exports` 下的临时 JSON/JSONL. 事务结束后, 只复制有正式记录的附件、音频和后台进程输出. 用户引用的外部文件不复制. 文件不存在或不可读时记录到 `omittedFiles`, 导出仍可完成, 返回结果带有警告.

`archiver` 直接读取这个临时目录, 分块压缩并写入用户所选位置旁的临时 ZIP. ZIP 写完并关闭后, 才重命名为所选路径并返回 `SessionExportResult`. 选中已有文件意味着允许替换它; 中途失败或取消不会破坏原有备份. 保存路径的父目录必须存在, 本包不代替文件选择器创建目标目录.

导入用 `unzipper.Open.file` 读取磁盘上的 ZIP, 各文件逐块解压到 `<dataDir>/.backup-temp/imports`. 写盘前检查路径越界和重名, 总展开体积限制为 8 GiB. ZIP 和资源文件不会整份读入内存; 解压后的 JSONL 记录仍会先读成数组, 完成关联校验后再交给数据库恢复.

记录必须属于所导入的 Session. 子消息的 Run 和摘要覆盖游标必须属于同一子代理. 同 ID 的会话或目标会话文件夹已存在时返回冲突, 不覆盖、改名或合并. 文件先发布到目标 Session 目录, 数据库随后在一个事务中恢复; 数据库失败时删除本次发布的目录. 根消息和 fork 子消息中的受管附件路径随文件改为目标数据目录, 用户外部文件引用不变. 原 Session 选中的模型在当前安装中不存在时清空该选择, 并返回警告; 历史模型来源仍保留.

## 断电与取消

- 正常失败或取消会删除本次临时目录和未完成的 ZIP;
- 下次启动构造 `SessionBackup` 时清空数据目录中的 `.backup-temp`;
- 强制结束进程可能在所选保存目录留下 `.ema-session-export-*` 临时目录. 它不属于数据目录中的 `.backup-temp`, 可手动删除, 不作为完成的 ZIP 使用;
- 不续传、不续压缩, 失败后整次重来;
- 来源机尚未结束的 Turn、Subagent 身份和 Run、Tool 执行及后台进程在导入时转成明确终态, 不会自动继续; running 子代理身份及 Run 转为 cancelled, Run 记录中断原因和结束时间. active Goal 则变为 paused, 保留原目标和反馈, 等待用户手动激活.

## 公共入口

```ts
const backup = new SessionBackup(
  activeDataDir,
  sessionBackupReader,
  sessionBackupRestorer,
  modelSelectionExists,
);

const exported = await backup.exportSession(sessionId, destinationPath, signal);
// exported.filePath 对应已写完的 ZIP; exported.warnings 说明未包含的资源.

const imported = await backup.importSession(zipFilePath, signal);
// imported.sessionId 可用于定位会话; imported.warnings 说明缺失文件或模型选择变化.
```

路径必须是运行后端的本机绝对路径. 桌面通过已有 Tauri 保存/打开对话框取得路径, 然后经受认证的 HTTP 请求交给本包. 前端不创建 Blob、下载链接或上传整份 ZIP. 普通浏览器没有原生文件选择器时, 存储页明确提示需要桌面窗口.

| 请求 | 输入 | 成功响应 |
| --- | --- | --- |
| `POST /api/sessions/:sessionId/export` | `{ destinationPath }` | `200 { filePath, warnings }`, ZIP 已保存 |
| `POST /api/sessions/import` | `{ filePath }` | `201 { sessionId, warnings }`, 会话已恢复 |

导入成功后, 路由发送带 `sessionId` 的 `session_list_changed` 事件, 由现有存储页和侧栏订阅刷新相关会话. 取消文件选择不发送请求, 也不提示失败. 请求或文件操作失败使用已有错误提示; 成功返回后才提示保存位置或导入完成.

## 验证

`pnpm --filter @ema-agent/backup test` 验证 ZIP 落盘和当前数据往返, 包括附件路径、子代理 Run/摘要、同轮多角色正式 WAV、文件缺失、取消和失败清理. HTTP 形状在 `apps/server/src/routes/backup/tests/` 验证; 按钮状态和通知在 `apps/desktop/src/settings/data/tests/` 验证. 原生文件对话框在组件测试中使用替身, 实机保存和打开仍需桌面验收.

`pnpm --filter @ema-agent/backup build` 先清空本包的 `dist`, 再编译当前源码. 删除或改名的源码不会在编译目录中留下可被误用的旧文件.
