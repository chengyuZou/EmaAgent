# Logging

[English](README.md)

本包把 Node 诊断记录编码为 UTF-8 JSONL, 直接通过 Node 文件写入流保存. Server 在启动业务包前用 `<Profile>/logs` 初始化日志. 业务包直接选择事件名和字段, 不在公共包集中维护业务事件名单.

```ts
import { logging } from '@ema-agent/logging';

logging({
  level: 'warn',
  target: 'speech',
  event: 'speech.save_failed',
  message: 'Failed to save speech audio.',
  error,
  body: { sessionId, turnId },
});
```

`logging()` 接收一个对象, 自动补充产生记录的进程 PID 和 UTC ISO 时间. `target` 表示业务模块, 例如 `speech` 或 `mcp`; `event` 是该模块提供的固定事件名. 所有级别都接收, 包括 debug. `level` 只描述严重程度, 不用于过滤日志.

`LogRow` 定义实际保存的日志行格式. `message` 说明正在做什么操作, `error.message` 说明底层为什么失败. 输入异常可以是 unknown, 统一转换为 `LogError`, 提取名称, 说明, 堆栈, 错误码, HTTP 状态码和 cause. 堆栈不需要开关. 循环或过深的 cause 链会省略并标记 `truncated`. 不复制 SDK 的请求, 响应和配置对象.

`body` 由调用方选择 JSON 兼容的业务值, 例如 Session ID, Turn ID, 数量和耗时, 默认空对象. 原生异常通过 `error` 传入. 字段含义和约束见 [types.ts](types.ts).

`logging.ts` 只串联构造记录, 脱敏, 限长和输出. 具体处理分别在 `internal/record.ts`, `internal/redact.ts`, `internal/limit.ts`. 脱敏针对消息文本, 错误内容和业务值, 使用常见凭据写法和 `setDiagnosticSecrets()` 登记的已知值处理副本. `apiKey` 等敏感字段名决定其值需要遮盖, 字段名自身保持原样. 固定的 `target` 和 `event` 原样保留, 不应写入用户文本或凭据. 调用方仍需选择值得记录的信息, 规则匹配不能识别所有任意秘密.

每条记录包含换行最多 8 KiB, message, error 与 body 共用这个预算. 结构限制约束遍历量, 超大单值在脱敏前整体省略, 避免留下无法匹配的凭据前缀. 后续截断保持 UTF-8 和 JSON 完整, 并标记 `truncated`. 普通 body 值的 getter 和自定义 `toJSON` 不会被调用. 循环引用会替换成省略说明, 无循环的重复引用仍保留内容.

## 文件写入与退出

Server 在业务启动前调用一次 `initializeLogging(directory)`. 目录由 Server 提供, Logging 不依赖 Storage, 不打开数据库. 初始化前的调用, 以及文件失败时的一条诊断信息, 使用 Node stderr. Rust 不解析或保存这些内容.

文件名为 `ema-<启动时间>-<pid>-<序号>.log`, 单文件最多 10 MiB. 启动, 轮换和容量不足时扫描识别出的日志文件, 按修改时间清理超过 14 天或超过 100 MiB 保留预算的已关闭文件. 当前写入流和其他仍存活进程的日志保留, 不删除无关文件或目录. 这些边界上的目录扫描是同步操作, 普通追加使用文件写入流.

文件在目录枚举后被其他进程删除时跳过该项. 删除操作发现文件已经不存在时, 也会扣除之前统计的大小, 避免并发清理导致停写或误报容量不足. 权限不足等其他元数据错误仍报告失败, 因为此时无法可靠统计文件大小.

写入流的缓冲阈值为 64 KiB. write 返回 false 时本条已经接受, 后续新调用计数并丢弃直到 drain, 不另外堆积发送队列. 恢复写入或关闭时, `logging.dropped` 报告数量. 最多同时保留当前流和轮换时仍在关闭的上一个文件. 拥堵恢复仍是 TODO, 已丢弃的正文无法补回.

`closeLogging(timeoutMs = 2000)` 停止接收, 等待已接受写入, fsync 和文件关闭, 失败或超时返回 false. 卡住的 I/O 尚不能独立重启, 关闭代码旁保留对应 TODO. Server 在业务收尾后调用它. 强制结束进程可能跳过收尾, 普通 write 完成也不保证断电后的保留. Tools 保存的命令 stdout/stderr 仍是独立的执行结果.

先运行 `pnpm --filter @ema-agent/logging build`, 再运行 `pnpm --filter @ema-agent/logging test`. 测试覆盖格式, 脱敏, UTF-8 限制, 循环与访问器, 实际文件轮换和保留清理, 并发清理, 拥堵计数, 以及真实 Node 子进程自行保存日志. 文件测试全部使用临时目录.
