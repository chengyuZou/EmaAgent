# Permission

[English](README.md)

Permission 决定工具调用可以执行, 必须拒绝还是需要用户确认. 规则匹配和判断顺序由本包负责. Tool 通过 `checkPermissions(input, context)` 提供操作信息, 不读取权限设置或保存批准.

## 入口与职责

执行器只调用 `checkToolPermission(tool, input, toolContext, permissionContext, { interactive })`. 该入口在 Permission 内调用 Tool 的 `checkPermissions`, 选择对应的分类检查, 最后返回 `PermissionCheckResult`.

`PermissionDecision` 是程序作出的 allow, deny 或 ask. `PermissionUserResponse` 是进入 ask 后用户选择的 allow, allowSession 或 deny. 直接允许或拒绝不会产生用户确认请求.

`PermissionRuleKey` 包含工具名和可选条件. 没有条件时匹配整个工具. `PermissionRule` 另外记录决定和来源. 用户及项目规则在 Turn 准备时读取; Session 批准在 Tool 的异步检查返回后读取, 已建立的执行器也能立即使用新批准.

## 判断顺序

1. 整个工具被禁止时, 不调用 Tool 的检查入口, 直接拒绝.
2. Tool 提供操作信息, 文件, 命令, 网页, MCP 或电脑检查准备匹配条件和确认要求.
3. 命中拒绝规则则拒绝.
4. 必须确认且没有可复用范围的请求始终询问. 电脑操控启动可匹配会话批准. 已获准的当前电脑操控不重复询问.
5. 命中本会话已批准范围则允许.
6. 明确的询问规则和必要确认仍然询问, 绕过权限模式不跳过它们.
7. 绕过权限模式放行到达这里的普通操作.
8. 命中允许规则或操作本身默认允许时放行, 其他操作询问.

工作区读取默认允许. acceptEdits 额外允许普通工作区写入. 普通写入和工作区外读取可以被 bypassPermissions 放行; 敏感路径和 MCP 报告的破坏性操作仍需确认, 已批准的会话范围可以复用. Plan 继续由 Turn 准备受限 ToolPool.

分类检查共用上述顺序. 文件检查解释路径和工作区范围. 命令允许规则必须精确覆盖完整命令, 或共同覆盖全部可靠解析出的子命令. 拒绝和询问规则可以命中其中任一子命令.

## 用户确认

ask 结果携带确认原因. 只有允许记住批准范围时, 才附带 `sessionApproval: { key, description }`. 聊天卡和原生通知显示原因及范围说明; key 留在后端, 前端只提交用户选择. 没有范围说明时仅显示允许和拒绝, 交互队列也不接受 allowSession.

Permission 不为任意输入自动生成批准规则. 普通工具明确选择整工具或完整输入的批准方式. 文件, 命令和网页检查提供各自的实际范围. MCP 明确使用完整输入, 不推测远端参数中哪些是路径或命令.

| 操作 | 记住的范围 |
| --- | --- |
| Read, Write, Edit, DescribeImage | 当前工具和当前文件 |
| Glob, 目录 Grep | 当前工具和当前目录及其子目录 |
| 网络目标类型未知的 Grep | 当前工具和完整输入, 批准前不探测远端 |
| Bash, PowerShell | 完整字面命令, 不自动扩大成前缀 |
| WebFetch | 精确 hostname, 包含不同路径和端口, 不包含子域名 |
| WebSearch | 搜索词和规范化的允许, 排除域名列表 |
| 电脑操控启动 | 整个启动工具, 允许本会话后续启动, 每次操控仍随 Turn 结束 |

`ToolCallExecution` 经现有宿主交互回调请求确认. Turn 先建立队列条目, 再发布请求. 用户选择 allowSession 后, Turn 先调用 `rememberSessionApproval`, 再发布处理结果并返回回答. 执行器随后检查取消, 才进入 Tool 的执行函数. 流式调度器仍负责安排调用顺序和交付结果.

## 文件与存储

用户和项目规则继续使用现有 Settings 项 `permission.rules.user.*`, `permission.rules.project.*`. 文本格式为 `Tool` 或 `Tool(condition)`, 解析器处理括号和反斜杠转义. 不需要新增独立 SQL 表.

`rememberSessionApproval`, `getSessionApprovals`, `clearSessionApprovals` 操作内存 Map. 批准可以只含工具名. 正常 Turn 完成后保留, 删除 Session 或退出进程后清除. 电脑操控状态不在这里另存一份.

文件检查解析符号链接, 新文件则解析最近存在的父目录. 网络路径在批准前不查询文件系统. 内部下载读取要求原路径和真实路径都位于宿主提供的可读目录内. 路径规则支持字面文件, 目录范围及现有相对, 绝对模式.

确认超时仍由 `permission.askTimeoutMs` 设置. null 表示不限等待时间, 取消仍会结束等待. 只有当前 Session 队首交互开始计时.

## 文件组织与验证

`checks/file` 和 `checks/shell` 保存较复杂的同类检查. 网页, MCP 和电脑检查各使用 `checks` 下一个文件. `rules` 负责读取配置, 解析 Key 和记住 Session 批准. `types.ts` 定义公共数据, 分类检查的中间结果只在 `checks` 内使用.

运行 `pnpm --filter @ema-agent/permission test` 和 `pnpm --filter @ema-agent/permission build`. 内置工具, 执行器, Turn, MCP 和 Desktop 的相关测试覆盖实际调用, 确认原因, 取消与按钮显示. 工作区导入使用编译文件, 测试调用方之前需要先构建其依赖.
