# @ema-agent/permission

Permission 只回答一个问题：**一次工具调用能不能执行**。它不执行命令、不隔离进程、不解析命令字符串、不持久化历史。批准不等于已经隔离--能否执行由 Permission 决定，如何隔离由 Sandbox 决定，两者物理分层。

## 边界

- **Permission 负责**：规则匹配（allow/deny/ask）、权限模式（ask/auto/bypass）、路径安全预检、危险路径识别、用户确认弹窗、Session 临时授权、决策归因。
- **Permission 不负责**：命令执行隔离（Sandbox）、命令语义分析（工具自带 `safetyCheck`）、输入 Schema 校验（`ToolRegistry.prepare`）、Hook 拦截（`hooks` 只观察）。
- **文字不是安全边界**：Tool description、Prompt 约束都不能代替 Permission 裁决与 Sandbox 隔离。Tool 的 `safetyCheck` 只贡献 bypass-immune 的快速拒绝，不替代规则。

## 主入口

`PermissionEngine.gate(tool, input, meta, context)` 是唯一裁决入口。Agent 主链固定调用 `ToolRegistry.prepare() -> PermissionEngine.gate() -> ToolRegistry.execute()`，Registry 不提供跳过审批快照的组合执行捷径。

## 12 步流水线

```text
工具调用请求
  ↓
─── bypass-immune（任何模式都跑）─────────────────────────────
 1. meta.safetyCheck          仅 bypassImmune 工具，deny 即拒
 2. checkPathSafety           所有解析路径，查注入/ADS/UNC/symlink
 3. deny 规则                 永久 global/workspace 规则
  ↓
─── early carve-outs ────────────────────────────────────────
 4. bypass 模式               非 immune 直接放行（dev/test only）
 4.5 internalPathCapability   封装型工具的显式目录能力证明
 5. 内部可编辑路径             write/execute，.ema-agent 等受授目录
  ↓
─── file-tool safety ────────────────────────────────────────
 6. 危险文件/目录名           .git/.ssh/.env 等 -> ask（非 deny）
  ↓
─── rule-based ──────────────────────────────────────────────
 7. ask 规则                  强制弹窗
 7.5 session grant            精确 input 快照复用
 8. allow 规则                所有 realpath 都须匹配
  ↓
─── mode-based ──────────────────────────────────────────────
 9. 工作区内 read             所有模式放行
10. 内部可读路径
11. auto 模式                 工作区写 + low-risk 非文件
12. ask 用户                  兜底
```

deny > ask > allow 由 Step 顺序保证。永久规则存入 `profile.db.permission_rules`；
Session 临时授权是精确操作指纹，不伪装成第三种持久规则作用域。

## 权限模式

| 模式 | 行为 | 用途 |
|---|---|---|
| `ask` | 无匹配规则则弹窗 | 默认，生产 |
| `auto` | 工作区内 + low-risk 自动放行，其余 ask | 信任度高的本地会话 |
| `bypass` | 非 immune 全跳 | **dev/test only，生产入口不启用** |

bypass-immune 只到 Step 1-3（safetyCheck/path-safety/deny）。ask 规则**不**bypass-immune--这与 Claude Code 不同，是有意设计：EmaAgent 的 bypass 仅供开发测试，不进生产，不需要"高危操作即使 bypass 也要确认"的安全阀。

不照搬 Claude 的 `default/acceptEdits/plan/dontAsk` 命名。未来 CLI 自动化可增 `dontAsk`（ask 转 deny），未来权限策略可叫 `PermissionMode = ask | trusted | autoReview`，但 `PermissionMode` 与 `ExecutionProfile = chat | work` 是两个独立维度，不得把 Work 等同于全自动放行。

## 规则

```ts
interface PermissionRule {
  action:    'allow' | 'deny' | 'ask'
  tool:      string         // '*' 匹配所有工具
  pathGlob?: string         // gitignore 语法，缺省匹配该工具所有路径
  scope:     'global' | 'workspace'
  workspaceRoot?: string    // scope=workspace 时必须提供绝对路径
}
```

pathGlob 用 `ignore` 库的 gitignore 语义：

```
//abs/path/**   锚定文件系统根
~/rel/**        锚定 home
 /rel/**         锚定 scope 根（workspace=workspaceRoot，global=home）
rel/**          同上，相对 scope 根
```

- **workspace**：绑定规范化工作区绝对路径，存 `profile.db`。
- **global**：全部工作区生效，存 `profile.db`。
- **Session Grant**：内存中保存用户选择“本会话允许此操作”的精确调用指纹，Session 结束清理，不属于 `PermissionRule`。

V1 不读取仓库内权限配置，因此仓库内容不能自行提升权限；本地单人应用也不实现企业 managed policy。

## 路径安全（bypass-immune）

`checkPathSafety` 在所有解析路径上跑，任何模式都执行：

| 攻击面 | 覆盖 |
|---|---|
| null 字节 | ✅ |
| shell 变量展开 `${VAR}` `%VAR%` | ✅ |
| glob 元字符 | ✅ |
| NTFS ADS `file.txt:stream` | ✅ Windows + WSL DrvFs |
| 长路径前缀 `\\?\` `\\.\` `//?/` `//./` | ✅ 两种斜杠 |
| UNC `\\server` `//server` | ✅ 全平台纵深防御 |
| 尾点/尾空格 `file.txt.` | ✅ |
| 8.3 短名 `PROGRA~1` | ✅ |
| DOS 设备名 CON/PRN/AUX/NUL/COM/LPT | ✅ 扩展名 + 路径段 |
| 三点路径段 `...` | ✅ |
| Unix 虚拟 fs `/proc/self/mem` `/dev/kmem` | ✅ |

### 符号链接逃逸防护

`getPathsForPermissionCheck` 返回 original **+** symlink-resolved 两种形式。allow 规则（Step 8）要求**所有解析路径都匹配**，防 `ln -s /etc/passwd /workspace/.env` 类攻击。新文件自身不存在时，`resolveExistingPathOrAncestor` 解析最近存在的父目录，防通过父目录 symlink 越出 workspace。

### 跨平台

- `getPlatform()` 区分 windows/wsl/linux/macos。WSL1/WSL2 都识别为 wsl，**WSL 上也跑 Windows 路径检查**（DrvFs 挂载走 Windows 内核，ADS 仍生效）。
- `normalizeCaseForComparison` 按平台：windows/macOS 转小写（文件系统大小写不敏感，防 `.cLauDe` 绕过）；Linux/WSL 保留原样（大小写敏感，避免 `/Home` 与 `/home` 被误判为同一目录）。
- macOS `/private/tmp` <-> `/tmp` 双向规范化。
- Windows 路径分隔符 `\` -> `/` 统一比较。
- 空 workspaceRoot（subagent）短路 false，防 `resolve('')=process.cwd()` 泄漏 sidecar cwd。

## 审批期间防替换（TOCTOU）

`promptUser` 等待用户回复后，重新解析路径并比对（`sameResolvedPaths`）。若审批期间参数、symlink 解析或能力快照变化，拒绝执行且不缓存授权。这保证"用户批准 A、实际执行不能换成 B"。

## Session 粒度隔离

- `sessionGrants`：per-session 临时授权，精确到**规范化 input 快照**（非 pattern）。同一 Session 内相同操作复用，跨 Session 隔离。
- `clearSession`：Session 结束清理临时授权。
- 审批按 Session 独立 FIFO，跨 Session 互不阻塞；响应使用 `turnId + promptId` 核对，不按当前页面或工具名猜。

## Headless 模式

无 `ask` 回调时（daemon/CI），Step 12 直接 deny 而非挂起。`PendingPermissionPrompt` 携带 `promptId`，供窗口重开或 SSE 重连后恢复界面。

## 文件职责

- `permissionEngine.ts`：12 步 gate 流水线、用户确认、规则快照和 Session Grant 管理。
- `paths/`：路径安全、工作区边界、内部路径能力和平台检测。
- `policy/permissionRules.ts`：规则匹配与 gitignore glob 解析。
- `policy/permissionRuleStore.ts`：永久规则窄存储接口与内存测试实现。
- `policy/sqlPermissionRuleStore.ts`：`profile.db.permission_rules` 适配。
- `policy/sessionGrants.ts`：Session 临时授权（精确调用指纹）。
- `types.ts`：PermissionEngine 类型与接口。
- `events.ts`：Permission SSE 事件类型。

## 与 Claude Code 的差异

| 维度 | Claude | EmaAgent | 原因 |
|---|---|---|---|
| 模式 | default/acceptEdits/plan/bypass/dontAsk + auto/bubble | ask/auto/bypass | 不照搬命名（评审 L807） |
| 规则来源 | 8（含企业 policy/MDM） | profile 全局/工作区 + Session Grant | 本地单人无需 MDM，也不信任仓库内配置 |
| ask 规则 bypass-immune | 是 | 否 | bypass 仅 dev/test，不进生产 |
| Hook 覆盖权限 | Hook 可 allow/deny | Hook 只观察 | Hook 不当第二套 Permission（评审 L435） |
| LLM 分类器 | 竞速自动审批 | 无 | V1 不做（评审 L1212），auto 是静态规则 |
| allow 路径覆盖 | 单匹配即可 | 所有 realpath 须匹配 | EmaAgent 更严，防 symlink 逃逸 |
| 审批期防替换 | 无 | `sameResolvedPaths` | EmaAgent 独有（评审 L800 要求） |
| session grant 粒度 | pattern | 精确 input 快照 | EmaAgent 更细 |
| Bash 命令路径提取 | 36 类命令专用提取器 | 无（BashTool 未实现 extractPath） | BashTool 缺口，不归 permission |
| 审计落盘 | toolDecisions Map + 遥测 | DecisionReason 仅内存 | 待补（评审 L1139） |

## 跨模块后续项

- **DecisionReason 不落盘审计**：结构完整（8 种类型），但无 Repository 写入；归 Observability/审计账批次，不影响 V1 执行门禁。
- **`ToolRegistry.dispatch()` 后门已删除**：可信调用方也必须显式建立 `PreparedToolCall`，Agent 主链继续在同一快照上完成审批与执行。
- **Bash 命令路径未进 permission 检查**：BashTool 未实现 `extractPath`，命令字符串里的路径（`cat /etc/passwd`）不经 path-safety。归 BashTool/sandbox 批次。

## 不做

- LLM 自动审批分类器（V1.5）。
- Trust Dialog（本地单人弱需求）。
- 企业 managed policy（本地单人不需要）。
- Hook 覆盖权限（评审明确反对）。
- 照搬 Claude 的 Bash 23 项静态检查 / tree-sitter AST（归 BashTool，且 Windows 收益有限）。
