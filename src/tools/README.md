# Tools 模块

`@ema-agent/tools` 拥有工具系统的通用框架：`Tool` 契约、宿主能力投影、进程级 Registry、根 Turn 的冻结 ToolPool、单次调用管线、流式批次调度、结果预算与外置、执行状态机、后台进程。

本 README 是接线前置条件：消费方只能使用这里列出的公共接口，绕过任何一个都会重新制造漂移。

## 所有权边界

**本包拥有：**

- `Tool<TInput, TOutput, TContext, TProgress>` 契约与 `buildTool()` 工厂（唯一工具形态，不存在第二套 ToolDef/BuiltTool/Descriptor);
- `ToolUseContext`（宿主能力全集）与 `ToolInvocation`（单次调用身份与取消）;
- `ToolRegistry`（进程级可变库存）、`ToolPool`（根 Turn 冻结快照）;
- 单调用管线 `ToolCallExecution` 与流式协调器 `StreamingToolExecutor`;
- `ToolExecutionState` 副作用边界状态机（prepared/authorized/running → 终态）;
- Results 层：`ToolResult` 信封、单项/聚合预算、外置落盘与回收；
- 后台进程：`BackgroundProcessRuntime`（15s 转交、双坑位池、日志、终态、完成通知）。

**本包不拥有（禁止反向依赖）：**

- 具体内置工具实现（归 `src/builtinTools`);
- 权限规则与决策（归 `@ema-agent/permission`，本包只 import 其公开类型）;
- OS 级隔离与进程后端（归 `@ema-agent/sandbox`);
- SQL、Row、snake_case（归 `@ema-agent/storage`;**本包不 import storage**，持久化一律走本包定义的窄端口，由 Core 装配注入实现）;
- Session/Turn 生命周期、SSE 编码、HTTP 路由、前端渲染；
- 任务（Task）业务语义（`@ema-agent/tasks`）与子 Agent 执行（`@ema-agent/agent`)。

## 目录

```text
src/tools/
├─ Tool/                          契约层
│  ├─ tool.ts                     Tool 接口、ToolOrigin、校验结果类型
│  ├─ buildTool.ts                工厂:fail-closed 默认值、maxResultBytes 校验、冻结
│  ├─ toolInvocation.ts           单次调用身份(session/turn/agentRun/toolCall/signal)
│  └─ toolUseContext.ts           宿主能力全集 + Subagent/AskUser/Scratchpad 等 Port
├─ assembly/                      装配层
│  ├─ toolRegistry.ts             进程库存;MCP 整批原子注册、来源冲突即错误
│  ├─ assembleToolPool.ts         validateContext 过滤 + Builtin 前缀/MCP 后缀稳定排序
│  └─ toolPool.ts                 冻结集合;filter() 只许收窄不许回读 Registry
├─ execution/                     执行层
│  ├─ toolCallExecution.ts        单次调用状态机(不对外导出)
│  ├─ streamingToolExecutor.ts    唯一批次协调入口(对外)
│  └─ toolExecutionState.ts       副作用边界状态机 + 持久化窄端口
├─ results/                       结果层
│  ├─ toolResult.ts               唯一结果信封(toolCallId/content/isError/durationMs/errorCode)
│  ├─ toolResultStore.ts          空输出占位、单项预算外置、聚合预算、稳定预览
│  └─ toolResultCleaner.ts        TTL + 单 Session + 全局配额回收
├─ background/                    后台进程
│  ├─ backgroundProcessRuntime.ts 15s 转交、双坑位池、列表/读取/停止
│  ├─ backgroundProcessScheduler.ts 公平轮转坑位
│  ├─ backgroundProcessStore.ts   后台进程持久化窄端口 + camelCase 记录
│  ├─ outputStore.ts              stdout/stderr 有界落盘与双游标读取
│  ├─ types.ts / events.ts / settings.ts
├─ events.ts                      Tool 事件(ToolStreamEvent/AskUser 事件)
├─ errors.ts                      本包全部错误类型
├─ types.ts                       ReadFileState、ToolCapabilityScope 等共享类型
└─ index.ts                       公共出口(见下)
```

## 公共接口与消费方

**工具作者消费**(`src/builtinTools`、MCP 适配层）:

- `Tool`、`buildTool`、`contextOk/contextFail`、`DEFAULT_MAX_RESULT_BYTES`;
- 每个 Tool 的 `execute()` 只返回类型化 `TOutput`;`mapResultToModelContent(TOutput)` 把同一结果投影为 Provider 中立的模型内容（缺省按"string 原样、其余 JSON 化"，复杂工具必须自定义）；信封 `data` 槽携带 TOutput 本体供 UI/审计/持久化；
- `ToolUseContext`、`ToolInvocation`、`ToolInputValidationResult`、`ToolContextValidation`;
- 宿主 Port 类型：`SubagentSpawnerPort`、`AskUserPort`、`ScratchpadPort`、`CommandRunnerPort`(sandbox 转出口径）。

**装配层消费**(Server wiring):

- `ToolRegistry`(Builtin 启动注册、MCP 热更新）、`assembleToolPool`、`ToolPool`;
- `StreamingToolExecutor` + `StreamingToolExecutorOptions` —— **执行的唯一公开入口；`ToolCallExecution` 不导出，任何包不得绕过协调器直接单发**;
- `ToolExecutionState` + `ToolExecutionStateStore`（端口）+ `ToolExecutionStateReader`（审计只读）——SQL 实现在 storage,Core 注入;
- `BackgroundProcessRuntime` + `BackgroundProcessStore`（端口）+ `BackgroundProcessPort`(Bash/Process 工具消费的窄口）+ `BackgroundProcessCompletionSource`(Server 完成通知）;
- `ToolResultStore`、`ToolResultCleaner`、`backgroundProcessSetting`。

**Agent/Turn 消费**:

- `ToolResult`（唯一结果信封）、`ToolExecutionEvent`、`AskUserQuestionSpec`、`PendingAskUserPrompt`;
- `ToolCapabilityScope`（只能收窄的能力边界）、`ReadFileState`;
- `BackgroundProcessEvent`。

## 关键不变量

1. **ToolPool 即冻结快照。** 根 Turn 冻结后不回读 Registry;MCP 热更新只影响下一根 Turn。不存在独立 Manifest/PreparedToolCall——Provider `tools[]`、缓存诊断、执行查找都从同一个 Pool 取。
2. **输入解析一次。** `inputSchema.parse` 只在单调用入口做一次，同一个局部 `input` 依次经过 validateInput → checkPermissions → execute。Permission 不修改输入；规范化必须由 Tool 显式返回新输入。
3. **`validateContext` 一身二任。** 装配时决定可见性，执行前重新投影——不得恢复 `requires` 第二份能力清单。
4. **running 是副作用边界。** `ToolExecutionState.start()` 落库成功后才能 `execute()`;running 后断电/取消按 `outcome_unknown` 关账，不伪装干净 cancelled。
5. **Message 先落，状态后关。** `acknowledgeResult`（写 Message）先于 `commitResult`（推进状态机）——先持久化后关账。
6. **终态 FIFO。** 完成可乱序，`tool_result` 终态必须按模型 blockIndex 顺序发射；进度事件实时但有界。
7. **后台双坑位池。** 交互命令独立小池（15s 内完成或转交），后台长任务吃 `maxConcurrent`;15s 转交时 detach 取消信号并交还交互坑位，转交后进程不再计入任何池。
8. **取消与降级诚实。** 无批准界面 deny、无 workspace 相对路径 fail-closed、超大结果先外置再给稳定预览（落盘失败当前原样放行，改有界错误待拍板）、后台 interrupted 墓碑不自动重跑。
9. **结果只有一份事实。** Tool 作者不同时返回 `data + modelContent`；模型内容必须由 `mapResultToModelContent(TOutput)` 在执行期投影一次并持久化（重放不重算）。缺省投影为 JSON/Text；复杂结果必须自定义映射，过滤内部字段并保留多模态语义；多模态 parts 不做文本外置，由 Tool 业务层自限尺寸。
10. **MCP 只有一个结果 Adapter。** 动态 MCP Tool 共用标准 `content` 转换；`structuredContent` 稳定 JSON 化，`isError` 进入失败路径，`_meta` 不进模型，图片/资源/二进制按各自协议语义处理。

## 失败语义速查

| 场景 | 结果 |
|---|---|
| 模型幻觉工具名 | `tool/unavailable`（不是权限拒绝） |
| Schema 解析失败 | `tool/validation_failed`，不产生状态迁移 |
| validateContext 失败 | `tool/context_unavailable`，不进 Pool |
| 权限拒绝 | `permission/denied`，不越过 running |
| 执行中用户取消 | 模型见 `tool/cancelled`，审计 `outcome_unknown` |
| running 后断电 | 启动恢复标 `outcome_unknown`，合成一次结果进 Message |
| MCP 自报低风险/免询问 | MCP Tool 自己的 checkPermissions 只升不降（`destructiveHint` 可升 ask） |

## 反模式（其他包禁止的行为）

- 从本包以外 import `toolCallExecution.js`（内部实现）或直接构造执行环境——只能消费 `StreamingToolExecutor`;
- 让本包 import `@ema-agent/storage`——持久化端口在 `toolExecutionState.ts` 与 `background/backgroundProcessStore.ts`,SQL 适配由 Core 装配；
- 在 Tool 上声明 `requires`、`permissionMeta` 或第二份安全状态——能力走 `validateContext`,权限语义走 `checkPermissions`;
- 用 `WeakMap`、全局 Map 或模块级单例给一次调用塞旁路数据——调用事实只活在 `ToolCallExecution` 局部与 `ToolResult`;
- 绕过 `checkPermissions` 在 Tool 里自行审批,或让 MCP 自报 annotations 降低本地风险（自报只能升风险,详见 `@ema-agent/permission` README）;
- 业务包重复定义 `BackgroundProcessStatus`、`ToolExecutionStatus` 等本包联合类型（备份链路消费 storage Row 是已登记的唯一例外）。
