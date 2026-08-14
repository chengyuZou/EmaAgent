# Permission

Permission 只回答一个问题：**一次已经完成业务校验的操作，在当前规则、模式和用户选择下能否继续执行。**

它不解析 Tool Schema，不执行 Tool，不启动 Sandbox，不实现 Session 队列，也不直接访问 SQLite。批准只代表策略允许；真实副作用仍必须经过 Sandbox 或对应平台执行器。

## 唯一授权入口

```ts
const decision = await permissionAuthorizer.authorize(request, askPermission);
```

执行链固定为：

```text
Tool Schema 与 Context 校验
  → Tool 业务硬安全校验
  → Tool 生成纯数据 PermissionIntent
  → PermissionAuthorizer.authorize()
  → Sandbox / 平台能力约束
  → Tool.execute()
```

任何调用方都不能因 Tool 属于 Builtin、MCP 或内部模块而绕过 `authorize()`。可信 Builtin 只能通过 `promptPolicy: 'neverForTrustedBuiltin'` 跳过普通询问，通用路径安全和 deny 规则仍然执行。

## 公共契约

`PermissionRequest` 由四部分组成：

- `tool`：稳定 Tool id 和批准界面名称；
- `input`：单调用执行器完成一次 Schema 解析后的同一份输入；
- `intent`：Tool 投影出的风险、访问类型和路径目标；
- `context`：本次调用的模式、工作区和 Session/Turn/ToolCall 身份。

一次操作可以包含多个 `targets`，例如复制文件同时包含读取源路径和写入目标路径。Permission 不再用 `extractPath()` 猜某个输入字段，也不保存 Tool 的 `safetyCheck()` 回调。

```ts
interface PermissionIntent {
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly accessType: 'read' | 'write' | 'execute';
  readonly targets?: readonly {
    readonly path: string;
    readonly accessType: 'read' | 'write';
  }[];
  readonly internalPathCapability?: 'turnScratchpad';
  readonly promptPolicy: 'whenRequired' | 'neverForTrustedBuiltin';
}
```

## 决策顺序

```text
请求完整性
  → 全部目标的原路径与真实路径解析
  → 通用路径硬安全
  → deny 规则
  → ask 规则
  → Session 精确授权
  → allow 规则（必须覆盖全部目标）
  → 显式内部目录能力
  → 工作区读取
  → acceptEdits 的工作区写入
  → 开发构建显式允许的 bypassPermissions
  → 可信 Builtin 免普通询问
  → 用户询问；没有询问端口时拒绝
```

规则优先级为 `deny > ask > Session grant > allow > mode/default`。`bypassPermissions` 也不能越过请求完整性、路径硬安全、deny 和 ask 规则。

## Permission Mode

| 模式 | 语义 |
|---|---|
| `default` | 工作区读取自动允许，其余按规则或询问 |
| `acceptEdits` | 额外允许工作区文件写入，不允许 execute |
| `bypassPermissions` | 仅显式开发入口可开启；正式装配必须禁用 |

Mode 是每个请求的不可变执行快照，不是 `PermissionEngine` 的全局状态。不同 Session 并行时不会互相切换权限模式。

## 批准等待与 Session 授权

批准等待由 `src/turn/interaction` 的统一 Session 队列负责：同 Session 的 Permission 与 AskUser 严格 FIFO，跨 Session 可以并行。Permission 本身只提交 `PermissionPrompt` 并等待 `PermissionResponse`。

- 默认没有倒计时，卡片会一直等待用户选择；
- 只有用户在设置中明确填写 5 至 600 秒，队首才在到期后自动拒绝；
- 排队但尚未成为队首的卡片不计时；
- Turn abort、Session 删除或应用退出仍会主动取消等待；
- SSE 断开不会自动拒绝，重连后从 pending snapshot 恢复卡片；
- 进程崩溃或断电不会把旧批准恢复成可执行操作。

`allowSession` 只保存当前 Session 内的精确请求指纹。指纹覆盖 Tool id、规范化输入、Mode、权限意图、工作区、全部真实路径和内部能力根；不包含 TurnId/ToolCallId 等动态身份。同一请求可在当前 Session 复用，输入、路径、模式或 Session 任一不同都必须重新询问。

用户响应后会重新计算完整指纹，并再次执行通用路径安全和 deny 规则。等待期间请求、symlink 目标或能力根发生变化时返回 `requestChanged`，不会执行也不会保存 Session 授权。

## 规则与持久化

V1 只保留两种真实持久规则：

- `global`：全部工作区生效；
- `workspace`：绑定创建规则时的规范化工作区绝对路径。

Session 临时授权只存在内存，不混入永久规则表。Permission 定义 `PermissionRuleStore` 窄端口；生产 SQL 适配器由 Server 装配并使用 Storage Repo，Permission 包不依赖 Storage。

执行器只接收 `PermissionAuthorizer`，规则 Route 只接收 `PermissionRuleCatalog`，不能给调用方一个宽对象后让它随意跨职责调用。

## 路径边界

- 相对路径必须有明确 `workspaceRoot`，禁止回退到 Server 的 `process.cwd()`；
- 原路径和 symlink/junction 真实路径都参加安全、规则和工作区判断；
- 新文件不存在时解析最近存在的父目录，防止父目录链接逃逸；
- Windows/WSL 的 ADS、设备路径、UNC、DOS 设备名与尾点尾空格会被拒绝；
- Unix 虚拟文件系统和 shell/glob 注入形式会被拒绝；
- Tool 隐藏真实路径时必须声明受信任的内部目录能力，Permission 不根据 SessionId 自行拼路径。

## 文件职责

```text
src/permission/
├─ permissionEngine.ts       唯一 authorize 主链和规则管理实现
├─ requestFingerprint.ts     批准复核与 Session grant 共用指纹
├─ types.ts                  公共请求、意图、决策、Prompt 与规则契约
├─ events.ts                 Permission 跨业务事件
├─ settings.ts               批准等待时间设置
├─ paths/                    路径安全、工作区和内部目录能力
├─ policy/                   规则匹配、Store 端口和 Session grant
└─ tests/                    授权顺序、路径、请求完整性和 Prompt
```

根出口不会公开 path helper、rule matcher 或 SessionGrantStore，外部不能用内部函数拼出第二条授权流水线。

## 当前不做

- LLM 自动审批；
- 企业托管策略和仓库内权限配置；
- Plan Mode 专属 Permission 枚举；
- Hook 覆盖 Permission 决策；
- Permission 内部的重复拒绝追踪。

连续拒绝后提醒模型改变策略属于 AgentLoop 行为，不应让 Permission 持有跨调用的模型控制状态。
