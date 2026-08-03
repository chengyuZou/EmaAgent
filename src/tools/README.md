# Tools 模块

`@ema-agent/tools` 拥有 Builtin 与 MCP 共用的工具契约、进程级 Registry、根 Turn 的 `ToolPool`、单调用执行、并发调度、结果预算、Journal 和后台进程。具体内置工具属于 `src/builtinTools`；权限规则属于 `@ema-agent/permission`；系统命令隔离属于 `@ema-agent/sandbox`。

## 公共契约

- `Tool<TInput, TOutput, TContext, TProgress>`：工具作者唯一实现的接口；项目中不存在第二套 `ToolDef`、`BuiltTool`、Descriptor 或 Entry。
- `ToolUseContext`：一次 Agent 装配可提供的业务能力全集，不含 Session、Turn 或 ToolCall 身份。
- `ToolInvocation`：一次调用的 `sessionId/turnId/agentRunId/toolCallId/signal`，不承载业务 Port、Permission 决策或通用事件出口。
- `ToolRegistry`：进程级可变库存，直接保存 `Tool`；只负责注册、撤销和查询，MCP 热更新只改变 Registry。
- `ToolPool`：根 Turn 从 Registry 筛选并冻结的有序 `Tool` 集合，是本轮模型 Schema、缓存诊断和执行查找的唯一事实源。

具体 Tool 用 `validateContext()` 从 `ToolUseContext` 投影窄 Context。根 Turn 组装 `ToolPool` 时用它决定工具是否可见；执行前再次投影，防止排队期间能力失效。不得恢复 `requires` 第二份能力清单。

项目不建立独立 Tool Manifest、Executable Manifest 或 `PreparedToolCall`。它们都会复制已经存在于 `ToolPool` 和当前调用局部变量中的事实，增加版本漂移和错误绑定的机会。

## 唯一调用顺序

```text
Registry.list()
  → assembleToolPool(context/profile)
  → 冻结本轮 ToolPool
  ├─ Provider tools[] 直接由该 Pool 投影
  ├─ Context Usage / 缓存诊断直接读取该 Pool
  └─ ToolExecution 按模型返回的 name 从该 Pool 查找 Tool
       → inputSchema.parse(rawArgs) 一次
       → validateContext
       → validateInput(input, context, invocation)
       → getPermissionIntent(input, context, invocation)
       → PermissionAuthorizer
       → execute(input, context, invocation, onProgress)
       → Result budget / Journal / FIFO terminal
```

解析后的 `input` 是一次调用的局部常量，同一个值依次进入业务校验、Permission 和执行。校验与 Permission 不得原地修改它；确实需要规范化的 Tool 必须显式返回新的规范化输入，并从 Permission 开始统一使用该值。禁止用深冻结、品牌类型或 WeakMap 重新包装一次调用。

Permission 接口已经封口。Tools 只 import `PermissionIntent`、`PermissionAuthorizer` 等公开类型，不复制 Permission Request、Response、Prompt 或规则结构。MCP 自报权限在单调用执行边界投影成可信的 Permission Intent，不能在 Registry 中维护第二份安全状态。

## 进度与结果

`TProgress` 只通过当前调用的 `onProgress` 上报，执行器补齐 Session、Turn、ToolCall 和 Tool 名称后形成 `tool_progress`。完成结果仍由 `execute()` 的 Promise 唯一返回，不能用进度事件伪装终态。

具体 Tool 先限制生产规模，通用 Results 层再执行 UTF-8 单项和聚合预算。超大结果的截断、受控落盘引用和回收属于 Results 层；具体 Tool 只负责自己的业务上限。
