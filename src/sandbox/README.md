# Sandbox 模块

`@ema-agent/sandbox` 拥有命令执行的**能力层**：平台/后端探测、沙箱后端包装、bash 可用性探测、工作目录校验、环境净化、子进程生命周期（输出封顶、超时、取消、进程树终止）与 bare-repo 防御。

本 README 是接线前置条件：消费方只能使用这里列出的公共接口，绕过任何一个都会重新制造漂移。

## 所有权边界

**本包拥有：**

- `CommandRunner` / `CommandRunnerPort`(Tool 层唯一消费的命令执行能力）;
- 探测二分：`detectPlatform`（我在哪个环境）与 `detectBackend`（这环境能用哪个后端，真实冒烟终审）;
- 三个后端：`bubblewrap`(Linux/WSL2)、`sandbox-exec`(macOS)、`unisolated`（如实降级，无物理隔离）;
- bash 探测：`BashProbeResult` 判别联合（`source:'native'+path` / `source:'wsl'` / unavailable),**不存在哨兵字符串**;
- `ShellSpec`（后端启动形态）、`SandboxCapability`（按 Session 冻结的能力快照）;
- 子进程原语：输出双流有界留存 + 原始流转发、超时、取消、POSIX 进程组/Windows taskkill 树杀；
- 环境白名单重建（不继承后删）、cwd 真实路径校验、bare-repo 签名表与防御。

**本包不拥有（禁止反向依赖）：**

- 安全策略（unisolated 时是否隐藏执行类工具、AGEN_UNSAFE_* 开关）——归 Server wiring(`createSandboxRuntime`);
- Git/WSL 安装动作（归 `apps/server/src/gitInstaller.ts`，本包只提供探测与缓存重置入口）;
- Permission 决策（归 `@ema-agent/permission`；本包不判断"该不该跑"，只负责"跑了就按能力约束跑");
- 具体工具（BashTool 等归 `src/builtin-tools`)、后台进程调度（归 `@ema-agent/tools/background`);
- `SandboxStatusWire` 等 UI 协议形状（归 Server wiring 组装）;
- SQL/Row/持久化（本包无任何存储依赖）。

## 目录

```text
src/sandbox/
├─ commandRunner.ts          冻结能力快照 + 后端选择 + 启动命令 + bare-repo 防御
├─ types.ts                  全部公共类型(见下"公共接口")
├─ detectPlatform.ts         环境分类:windows/macos/linux/wsl1/wsl2(只答"我在哪")
├─ detectBackend.ts          平台→后端映射 + 真实冒烟(echo 走完整 wrap 路径)
├─ bashProbe.ts              bash 探测:异步回退链 + Promise 缓存 + probeBashSettled 同步 peek
├─ buildSandboxConfig.ts     Capability→后端配置;全路径 realpath 规范化(剥 \\?\ 前缀)
├─ resolveCommandCwd.ts      cwd 解析与能力范围校验(真实路径防符号链接逃逸)
├─ processEnvironment.ts     子进程环境白名单重建(刻意最小,非遗漏)
├─ processRunner.ts          spawn + 输出封顶 + 超时 + 取消 + 进程树终止(原语层)
├─ bareRepoSurface.ts        bare-repo 签名/落点/并集单点表 + hasBareRepoSignature
└─ backends/
   ├─ bubblewrap.ts          Linux 直启 argv;Windows 经 wsl.exe 路由 + /mnt/<drive> 翻译
   ├─ sandbox-exec.ts        macOS SBPL profile(deny default 起手)
   └─ unisolated.ts          原样执行;wsl 形态经 wsl.exe 路由
```

## 公共接口与消费方

**Tool 层消费**(`@ema-agent/tools` 经 `ToolUseContext.commandRunner`):

- `CommandRunnerPort`:`start(command, options) → CommandProcessHandle`、`run(...) → Promise<CommandRunResult>`;
- `CommandRunOptions`(`cwd/timeoutMs/signal/onOutput`)、`CommandProcessHandle`(`completion/stop`)、`CommandRunResult`、`CommandOutputChunk`;
- `start()` 是同步路径（后台调度立即持有句柄）:shell 冷窗口与无 bash 都**抛错**，调用方按 Tool Error 如实上报。

**装配层消费**(Server wiring):

- `CommandRunner`(per-Session 构造，能力快照构造即冻结）、`SandboxCapability`;
- `detectBackend()` → `DetectResult { backend, degradeReason? }`（进程级缓存，启动期调用）;
- `probeBash()`（启动 fire-and-forget 预热）、`probeBashSettled()`、`resetBashProbeCache()`（测试与 Git 安装后重探）;
- `BackendKind`、`ShellSpec`、`SandboxBackend`（类型）、`WrappedCommand`、`SandboxCommand`、`SandboxConfig`。

**禁止消费**：后端类、`buildSandboxConfig`、`resolveCommandCwd`、`processRunner`、`bareRepoSurface` 均为内部实现，不从 `index.ts` 导出，任何包不得深路径引用。

## 关键不变量

1. **探测二分。** `detectPlatform` 只做环境分类（同步、微秒级、纯函数可测）;"能不能用哪个后端"一律由 `detectBackend` 的真实冒烟终审——二进制存在 ≠ namespace/策略允许。
2. **能力构造即冻结。** `workspaceRoot` 必填，空串拒绝构造，禁止回退进程 cwd;`writablePaths/forbiddenPaths` 冻结后不可变。
3. **Permission 与 Sandbox 物理分层。** 本包不裁决策略；`unisolated` 只如实报告"无 OS 隔离"，是否允许执行由 Server 策略决定（默认隐藏执行类工具）。
4. **环境只白名单重建。** 子进程环境清空后按白名单重建，不继承后删；凭据/注入类变量默认不存在。
5. **路径比较一律真实路径。** cwd 校验与配置绑定同口径 realpath(Windows 剥 `\\?\` 前缀）；符号链接/junction 逃逸 fail-closed。
6. **结算一次、终止一次、清理一次。** `settled` 防多终态事件重复结算；`terminating` 幂等入口收编超时/取消/stop 三源；每条结局路径对称清理（补枪定时器必须撤——进程提前退出后 PGID 复用会误杀无辜）。
7. **输出两条通道各有界。** onOutput 原始流（供日志落盘）与内存留存（100KB/流，头+尾+通知不破位）分离；onOutput 消费方抛错被捕获、停止转发、**命令继续跑**；跨块多字节字符经 StringDecoder 拼齐，不碎。
8. **网络只有两档。** `none` / `full`，不声称域名白名单；macOS profile 以 `(deny default)` 起手，full 必须显式 allow。
9. **bare-repo 只记录与警告，永不删除。** git init 与攻击形态相同，误删代价比残留更糟。
10. **探测结果类型即真相。** `BashProbeResult`/`ShellSpec` 判别联合表达 native/wsl 两种形态；消费方按 `source/kind` 分支，不得再引入哨兵字符串或"可能是假路径"的字段。

## 失败语义速查

| 场景 | 结果 |
|---|---|
| spawn 启动失败（ENOENT 等） | `completion` **reject**（不是 exitCode -1) |
| 被信号杀死 / 预检已取消 | resolve,`exitCode: -1`,`aborted` 如实标记 |
| 超时 | `timedOut: true`,TERM → 3s → KILL 整棵树 |
| 输出超 100KB/流 | `truncated: true`，头+尾留存+流内通知，总量不破位 |
| shell 探测冷窗口 | `start()` 抛"Shell 探测尚未完成"（启动预热后实际不可达） |
| 无 bash(Windows) | `start()` 抛安装引导错误；路由层用 probe 结果引导 WSL2 |
| cwd 越出能力范围 | 抛错拒绝，不悄悄执行 |
| 执行后长出 bare-repo 签名 | `console.warn` 响亮警告，不删任何路径 |
| onOutput 消费方抛错 | warn 记一笔、停止转发，命令继续跑完 |
| 后端冒烟失败 | 降级 unisolated + 人类可读 degradeReason，不谎报 isolated |

## 反模式（其他包禁止的行为）

- 绕过 `CommandRunnerPort` 直接 `child_process.spawn` 执行模型命令——能力约束（cwd/环境/超时/树杀）全部失效；
- 在命令执行路径读 `process.env` 或自行拼环境——环境只来自本包白名单重建；
- 把 `BashProbeResult.path` 当恒真路径（wsl 形态无路径），或在同步路径 `await probeBash()`——同步路径用 `probeBashSettled()` 并诚实处理 `undefined`;
- 在本包加策略判断（"该不该跑")、安装动作（装 Git/WSL）或 UI 协议类型——能力层不管策略，安装归 server,Wire 归 wiring;
- 每次执行重新探测后端/shell——探测均进程级缓存，CommandRunner 构造一次；
- 业务包重复定义 `BackendKind`、`ShellSpec`、`CommandRunResult` 等本包联合（前端经 Wire 协议取，不镜像本包类型）;
- 依赖字符上限防 fork 炸弹——资源耗尽防护见 TODO #9.1 的分层结论（策略门/WSL2 VM 围墙/超时树杀），V1 如实标注无进程数墙。
