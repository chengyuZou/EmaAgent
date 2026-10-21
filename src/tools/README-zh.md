# Tools

[English](./README.md)

本包定义工具, 组装有序 ToolPool, 检查权限并执行调用, 保存执行状态和超大结果. Shell 命令转后台后也由本包继续管理.

## 定义与组装

工具通过 `buildTool()` 提供输入 Schema, `validateContext`, 权限检查和 `execute`. 工具返回业务结果, `mapResultToModelContent` 选择模型可见内容. 未提供映射时, 字符串原样返回, 其他结果转为 JSON.

`ToolUseContext` 保存宿主能力. 每次调用通过 `validateContext` 检查并取出需要的能力. `ToolInvocation` 单独提供 Session, Turn, ToolCall 身份与取消信号.

`ToolRegistry` 保存实现. 内置工具单独注册, MCP 批次先完成名称, ID 和来源冲突检查, 再替换实现. `assembleToolPool()` 把内置工具排在前面, MCP 按原始 Server 与工具身份排序. 调用方再按设置, 权限模式和主/子代理范围筛选.

Pool 保留同一批 Tool 对象, 不回读 Registry. MCP 更新影响后续准备, 不改变已经准备好的 Turn. 宿主是否提供了执行能力在真正调用时检查, 不在组装列表时检查.

## 执行顺序

公开执行入口为 `StreamingToolExecutor`. Agent 必须先保存 tool_use 消息, 再调用 `addTool()`.

```text
保存 tool_use
  -> 解析一次 Schema, 检查 Context 和业务输入
  -> 保存 prepared, 检查权限并按需等待批准
  -> 保存 authorized, 再保存 running
  -> 调用 execute, 生成模型可见结果
  -> 按模型 block 顺序交付 ToolResult
  -> Agent 保存 tool_result Message
  -> acknowledgeResult 推进执行终态
```

输入无效或缺少能力时不会进入权限检查. 没有批准通道时, 需要批准的调用会被拒绝. 会话批准规则由宿主保存, 详见 [Permission](../permission/README-zh.md).

并发安全调用可以同时执行, 但要等待前一个独占调用. 独占调用等待此前全部调用完成, 并阻止后续调用越过自己. 即使后面的调用先完成, 结果和终态事件仍按模型 block 顺序交付. 进度事件实时转发.

必须保存结果 Message 后再调用 `acknowledgeResult()`. `running` 在执行工具前保存; 越过这个位置后取消不能证明没有副作用, 因此执行状态记为 `outcome_unknown`, 模型可见结果仍可以是取消. 写状态时检查 version, 避免迟到结果覆盖新状态.

关闭时取消调用, 默认最多等待五秒. 仍未结束的调用停止对外发事件, 并根据是否开始执行记录状态. `reset()` 用于已完成的 LLM 迭代之间, 不能用来丢弃活跃调用.

## 结果与文件状态

`ToolResult.content` 是已经生成并保存的模型内容. `data` 保存供 UI 和历史读取的业务结果. 多模态内容原样交付, 体积由工具自身限制.

文本默认每项预算为 50 KiB. 超限时, `ToolResultStore` 把全文写到 `data/tool-results/<sessionId>/`, 返回路径和最多 2,000 字节的 UTF-8 安全预览. 当前实现在落盘失败时返回原文, 因此磁盘故障下这个预算并非绝对上限.

`ToolResultCleaner` 接收 `data/tool-results/` 根目录. `ToolResultCleaner.sweep()` 先清理七天前的文件, 再按从旧到新的顺序限制单 Session 50 MiB 和全局 500 MiB. 文件操作最多八路并行, 调用时机由宿主安排.

`FileStateCache` 在同一 Session 的 Turn 与子代理间共享. LRU 最多保存 100 项和 25 MiB 正文. 范围读取保留范围信息; 文件修改时间变新时, 只有缓存了完整原文才能通过换行归一化后的全文相等判断接受写入. Session 删除和 Server 关闭时释放, 不从历史消息恢复.

## Shell 后台进程

`BackgroundProcess.runCommand()` 接收 `CommandStarter`, 使用其 `start`, `completion` 和 `stop`. Bash 与 PowerShell 分别准备自身的命令.

- 普通调用不再等待独立的进程名额, 工具层的权限与并发检查仍然生效. 180 秒内完成则返回普通结果, 删除临时日志, 不保留进程行.
- 超过 180 秒后, 同一进程登记为后台运行, 保留日志并解除原 Turn 的取消信号和进度回调. 它不占显式后台队列的名额.
- 显式后台调用立即保存, 所有 Session 按提交顺序 FIFO 等待空闲名额. 并发数默认 32, 可设置为 1-128. 该设置只限制显式后台命令, 不是所有 Shell 进程的总上限. 取消排队项不会启动进程, 也不会释放运行名额.
- 最长运行时间默认 24 小时, 可设为一到 168 小时. 单条命令可请求更短时间. 提交时固定上限, 实际启动后计时, 排队不计入.
- 提交命令与实际启动排队命令前都检查 Session 是否仍允许工作.
- 日志写入失败会停止命令并报告失败. UI 进度通知失败只关闭该回调.
- stdout 和 stderr 各保留最多 16 MiB, 包括截断提示. 读取使用独立字节偏移, 每个流每次最多 64 KiB, 等待新输出最多 30 秒.
- 正常完成, 失败和超时先保存日志与终态, 再向宿主通知执行引用. 完整输出另行读取.
- `stopForSession()` 同时通知前台, 后台和排队命令停止, 然后等待. 永久删除 Session 前通过 `discardSession()` 关闭日志. 启动恢复把已记录的 queued/running 改为 interrupted, 不自动重跑.

## 阅读与验证

先看 [Tool](./Tool/tool.ts), [组装入口](./assembly/assembleToolPool.ts) 和 [StreamingToolExecutor](./execution/streamingToolExecutor.ts). 单次调用的顺序在 [toolCallExecution.ts](./execution/toolCallExecution.ts), 后台转交和停止在 [backgroundProcess.ts](./background/backgroundProcess.ts).

运行 `pnpm --filter @ema-agent/tools test` 和 `pnpm --filter @ema-agent/tools typecheck`. 测试覆盖注册冲突, 调度, 结果保存确认, 取消, 结果文件与后台执行, 使用临时 SQL 和日志目录. 后台测试也会启动真实 Node 子进程验证日志写入失败.
