# Sandbox

[English](README.md)

Sandbox 使用当前机器可用的隔离后端运行 Bash 命令, 同时提供原生 PowerShell 共用的进程执行函数, 以及 Bash 和集成终端的 Shell 查找.

## 执行命令

```ts
import { CommandRunner, probeBash } from '@ema-agent/sandbox';

const bash = await probeBash();
if (!bash.available) throw new Error('Bash is unavailable');
const shell = bash.source === 'wsl'
  ? { kind: 'wsl' as const }
  : { kind: 'native' as const, path: bash.path };

const runner = new CommandRunner({
  cwd: workspace,
  writablePaths: [workspace, temporaryDirectory],
  forbiddenPaths: databaseFiles,
  networkAccess: 'none',
}, shell);

const handle = runner.start('printf hello', { timeoutMs: 5_000, signal });
const result = await handle.completion;
```

调用方先完成 Bash 探测再构造运行器, 并在启动命令前完成权限检查. `start()` 同步返回 `{ completion, stop }`, 不会再启动一轮 Bash 探测.

Server 在 Bash 启用时提前查找 Bash. Turn 准备阶段, 只有选定的工具池包含 Bash, `prepareTurnTools()` 才等待 `getCommandRunner()`. Plan 或没有 Bash 的工具池跳过等待. 多个调用共用探测, 取消某次 Turn 不会取消所有人的探测. 等待结束后, Turn 会检查自己的取消信号, 再组装工具上下文.

Server 提供 Session cwd, 当前项目文件夹, 临时目录, 以及禁止读写的 Profile/Data SQLite 文件和伴随文件. 运行器复制这些路径和当前网络设置, 后续变更影响之后创建的运行器. 同一次 Turn 中的子 Agent 共用准备好的运行器.

```text
Server 提前查找 Bash
    -> Turn 选择工具池
    -> 包含 Bash 时等待探测, 构造 CommandRunner
    -> 权限批准
    -> CommandRunner.start 解析 cwd 并包装命令
    -> startProcess 返回句柄
    -> completion 返回退出结果或失败
```

能力配置中的 cwd 不能为空. 命令未指定 cwd 时使用 Session cwd, 相对路径也以它为起点. 已存在的路径使用 realpath. 其他启动目录必须位于明确提供的可写根内. Session 原来的 cwd 即使已从项目移除, 仍可作为起点, 但这不会授权写入, 也不允许把它的子目录作为新的起点.

## 后端与路径规则

`detectBackend()` 在当前进程内缓存结果. 它使用断网配置包装并执行 echo, 同时检查退出码和固定标记. 这证明后端能够启动, 不等于所有文件与网络规则都已验证.

| Node 进程环境 | 探测方式 |
| --- | --- |
| Linux 或 WSL2 | 直接启动 bwrap. |
| macOS | 使用内联 SBPL 规则启动 sandbox-exec. |
| Windows | 通过默认 WSL 发行版启动 bwrap. |
| WSL1 | 返回 unisolated. |

启动失败时返回 `unisolated`, 并保留实际启动错误, stderr 或缺少标记的说明. Server 此时默认不注册 Bash 工具. 开发环境可以用 `AGEN_UNSAFE_SHELL=1` 启用无沙箱 Bash, 正式环境拒绝这个开关.

Bubblewrap 先把根文件系统设为只读, 再叠加可写目录, 只读路径和隐藏路径. macOS 从默认拒绝开始, 允许读取和必要的进程操作, 然后开放指定写入并覆盖明确禁止的路径.

工作区根同时存在 HEAD, objects 和 refs 时, 才把已有的 bare Git 仓库文件设为只读. 普通项目的 config 文件或 hooks 目录不会仅因为名字相同就变成只读. 运行器不会在命令结束后扫描或删除新建的 Git 文件.

网络设置只有 `none` 和 `full`, 默认 none. 无沙箱执行不实施这些文件与网络规则. 原生 PowerShell 使用独立的命令分析和权限流程, 不经过 Bash 沙箱. 这些后端也没有配置 CPU, 内存或进程数配额.

Windows 盘符路径按 WSL 默认 `/mnt/<drive>/...` 布局转换. 不查找自定义挂载位置, 不将 UNC 路径挂载到 WSL.

设置页的 `SandboxStatus` 由 Server 定义, 包含 `backend`, `bashMode`, `networkAccess` 和可选 warning. `bashMode` 表示 Bash 的启用策略, 不是可执行文件的就绪状态, 也不表示 PowerShell 已隔离. 前端通过 HTTP Route 推导这个类型.

## 输出, 取消与失败

`startProcess()` 接收明确的可执行文件, argv, cwd 和环境变量. Bash 只复制允许的路径, 主目录, 临时目录和区域设置变量, 并设置 TERM=dumb, PAGER/GIT_PAGER=cat. API 密钥和进程注入变量不会复制进去. 原生 PowerShell 提供自己的环境变量.

stdout 和 stderr 各自最多保留 100,000 个 UTF-16 码元, 包括截断提示. 保留开头和结尾, 避免劈开代理对, 返回前移除末尾空白. UTF-8 解码会跨输出块继续, 不按每块单独转换.

`onOutput` 在截断前接收原始字节, 用于保存命令输出. 它抛错时, 运行器请求停止命令, 继续读取管道但不再调用失败的保存函数, 等进程 close 后拒绝 completion. BackgroundProcess 单独处理可选的界面进度通知, 通知失败只关闭通知, 不停止日志或命令. 持久后台记录会保存实际失败原因.

| 情况 | completion 行为 |
| --- | --- |
| signal 启动前已取消 | 不启动进程, 返回 aborted 且 exitCode 为 -1. |
| 启动错误 | 拒绝 Promise. |
| 输出保存失败 | 停止命令, 等 close 后拒绝 Promise. |
| 正常退出 | 返回退出码, 没有退出码时为 -1. |
| 超时 | timedOut 为 true, aborted 保持 false. |
| 主动停止或取消 | aborted 为 true, 已经超时则以超时为准. |
| 完成后再调用 stop | 不再发送终止请求. |

CommandRunner 默认超时 120 秒, 传入值最多七天. Windows 使用 taskkill /T /F 请求终止进程树. POSIX 向进程组发送 SIGTERM, 必要时三秒后发送 SIGKILL. 进程结束会清除延迟终止定时器. 停止请求可能失败, stop 返回不等于已经确认所有后代进程退出.

## 阅读与测试

- [command/commandRunner.ts](command/commandRunner.ts) 和 [command/commandPaths.ts](command/commandPaths.ts): 准备好的 Bash 执行入口与路径规则.
- [process/processRunner.ts](process/processRunner.ts): 进程生命周期, 输出和终止.
- [backends/detectBackend.ts](backends/detectBackend.ts): 共用的后端启动自检.
- [discovery/bashProbe.ts](discovery/bashProbe.ts) 和 [discovery/terminalShells.ts](discovery/terminalShells.ts): Bash 查找与集成终端候选.
- [Server 装配](../../apps/server/src/composition/tools.ts): 实际路径, 启用策略和状态响应.
- [PowerShell 运行器](../builtin-tools/tools/PowerShellTool/powershellRunner.ts): 原生进程路径.

Windows 依次查找 PATH, Git 可执行文件所在安装目录, Git 注册表, 最后在 WSL 中实际运行 Bash. 并发调用共用 Promise. 非 Windows 返回约定的 /bin/bash 路径, 不检查该程序. 终端查找列出已经存在的候选路径, 不保证每种 Shell 都能启动交互会话.

运行 `pnpm --filter @ema-agent/sandbox test` 和 `pnpm --filter @ema-agent/sandbox typecheck`. 相关回归还包括 Tools 的 backgroundProcessRuntime 测试, Turn 的 prepareTurnTools 测试和 Server 的 systemStatusRoute 测试. 在 Windows 上通过后端参数测试, 不代表已经验证 macOS 或 Linux/WSL 的实际隔离能力.
