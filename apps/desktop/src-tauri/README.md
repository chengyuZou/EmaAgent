# Desktop Rust Host

`apps/desktop/src-tauri` 是 Ema Desktop 的原生宿主。它只负责窗口与托盘、平台能力、Server/Narrative 子进程启动和退出，以及 WebView 访问本机 Server 所需的连接信息。业务规则仍归 `src`，HTTP/SSE 装配仍归 `apps/server`。

本文是 Rust、Desktop WebView、Server 与 Narrative Bridge 之间固定接口的唯一人工对照表。修改表中名称、参数或返回形状时，必须在同一批同步所有生产者、消费者与真实进程冒烟；不得只在某一端增加兼容别名。

## Tauri Command

自有 Command 只允许在 `src/commands` 定义、在 `src/lib.rs` 注册，并由 `apps/desktop/src/lib/tauri-bridge.ts` 的同名语义方法调用。其他前端文件不得直接写 Command 字符串。

| Command | WebView 参数 | Rust 返回 | 前端方法 | 业务意义 |
|---|---|---|---|---|
| `get_server_secret` | 无 | `Result<String, String>` | `getServerSecret()` | 取得本次 Desktop 启动生成的 Server 访问口令 |
| `get_server_port` | 无 | `Result<u16, String>` | `getServerPort()` | 取得本次 Desktop 启动的本机 Server 端口 |
| `get_narrative_port` | 无 | `Result<Option<u16>, String>` | `getNarrativePort()` | 查询已接入 Server 的 Narrative 实际端口 |
| `start_narrative` | 无 | `Result<u16, String>` | `startNarrative()` | 本次运行手动启动 Python 并接入当前 Server |
| `wait_narrative_exit` | 无 | `Result<(), String>` | `waitNarrativeExit()` | 等待 `/internal/shutdown` 后 Python 子进程完全退出 |
| `open_window` | `{ label }` | `Result<(), String>` | `openWindow(label)` | 显示或聚焦 `main`、`chat`、`settings` 中的窗口 |
| `quit_app` | 无 | `()` | `quit()` | 关闭子进程后退出 Desktop |
| `set_always_on_top` | `{ value }` | `Result<(), String>` | `setAlwaysOnTop(value)` | 设置当前窗口是否置顶 |
| `set_passthrough` | `{ value }` | `Result<(), String>` | `setPassthrough(value)` | 设置当前窗口是否忽略鼠标事件 |
| `list_terminal_shells` | 无 | `DetectedTerminalShell[]` | `listTerminalShells()` | 返回本机可发现 Shell 的显示名、类型与绝对可执行路径 |
| `open_terminal` | `{ terminalId, sessionId, cwd?, shellExecutable?, columns, rows, onEvent }` | `Result<(), String>` | `openTerminal(input)` | 使用当前选择的 Shell 创建交互 PTY，并用 Channel 发送输出 |
| `write_terminal` | `{ terminalId, data }` | `Result<(), String>` | `writeTerminal(...)` | 向指定 PTY 写入用户输入 |
| `resize_terminal` | `{ terminalId, columns, rows }` | `Result<(), String>` | `resizeTerminal(...)` | 同步 xterm 与 PTY 尺寸 |
| `close_terminal` | `{ terminalId }` | `Result<(), String>` | `closeTerminal(...)` | 关闭一个 Shell |
| `close_session_terminals` | `{ sessionId }` | `Result<(), String>` | `closeSessionTerminals(...)` | 删除 Session 时关闭其全部 Shell |
| `open_browser` | `{ browserId, url, bounds }` | `Result<(), String>` | `openBrowser(...)` | 在 Chat 窗口中创建原生网页视图 |
| `navigate_browser` | `{ browserId, url }` | `Result<(), String>` | `navigateBrowser(...)` | 导航到新地址 |
| `browser_back` / `browser_forward` | `{ browserId }` | `Result<(), String>` | `browserBack(...)` / `browserForward(...)` | 操作页面历史 |
| `reload_browser` | `{ browserId }` | `Result<(), String>` | `reloadBrowser(...)` | 刷新页面 |
| `set_browser_bounds` | `{ browserId, bounds }` | `Result<(), String>` | `setBrowserBounds(...)` | 对齐原生页面与 Dock 正文区域 |
| `set_browser_visible` | `{ browserId, visible }` | `Result<(), String>` | `setBrowserVisible(...)` | 标签隐藏或激活时同步原生页面显隐 |
| `close_browser` | `{ browserId }` | `Result<(), String>` | `closeBrowser(...)` | 释放一个原生网页视图 |

`plugin:opener|open_url` 和 `plugin:opener|reveal_item_in_dir` 属于 Tauri 插件，不是 Ema Rust Command；它们仍只能出现在 `tauri-bridge.ts` 内。

Shell 检测不扫描固定盘符。Windows 使用 `where.exe` 收集 `PATH` 中全部匹配路径，并补入 `COMSPEC`；macOS/Linux 使用 `$SHELL` 与 `which -a`。同一类型的多个可执行文件按绝对路径分别返回。设置 `frontend.terminal.shellExecutable` 只影响之后新建的终端，已经运行的 PTY 不重启也不换 Shell。

## 子进程环境变量

这些环境变量只在 Rust Host 与它启动的子进程之间传递。WebView 不读取环境变量，也不复制这些名称。

| 名称 | 生产者 | 消费者 | 是否必需 | 业务意义 |
|---|---|---|---|---|
| `EMA_SHARED_SECRET` | Rust Host | Server、Narrative | 是 | 本次 Desktop 生命周期内的 HTTP 访问口令 |
| `EMA_NARRATIVE_DIR` | Rust Host | Narrative | 是 | 当前 `witch-trial` 剧情数据的绝对目录 |

以下名称属于宿主启动位置覆盖，不会传给 WebView 或作为业务状态保存：

| 名称 | 读取者 | 作用 |
|---|---|---|
| `EMA_SERVER_EXECUTABLE` | Rust Host | 覆盖正式环境默认的 Server 可执行文件位置 |
| `EMA_NARRATIVE_BRIDGE_EXECUTABLE` | Rust Host | 覆盖正式环境默认的 Narrative 可执行文件位置 |

新增环境变量前必须同时指出具体生产者和消费者。仅有读取代码、测试注入或“以后可能使用”的名称不进入本表，也不应留在实现中。

## 控制消息

Server 与 Narrative 真正监听后分别从 stdout 输出 JSON-RPC 2.0 notification:

```json
{"jsonrpc":"2.0","method":"server.ready","params":{"port":43120}}
{"jsonrpc":"2.0","method":"narrative.ready","params":{"port":43121}}
```

Rust 在两者就绪后向当前 Server 的 `POST /internal/narrative/control` 发送:

```json
{"jsonrpc":"2.0","id":1,"method":"narrative.attach","params":{"port":43121}}
```

Python 意外退出后 Rust 发送 `narrative.detach` (无 `params`) 让新 Turn 不再取得旧 Client. Server 用同一 `id` 返回 `result:null` 或 JSON-RPC error. Server 开发重启后再次发 `server.ready`, Rust 用当前 Python 端口重新接入. `narrative.startOnLaunch` 存在 Profile SQL 中, TS Settings API 负责读写, Rust 每次开机只读一次. 运行中的手动启停不改开机偏好.

构建清单里的 Cargo crate 版本、依赖版本和 Python 项目打包版本是构建工具要求, 不属于上述运行接口.

## 验证

跨进程接口不能只靠单语言测试确认。正式制品验证必须启动真实 Server 和 Narrative，至少证明：

1. 两个子进程都能读取 Rust 提供的必需环境变量；
2. 两条 stdout ready 消息都能被 Rust 解析为有效端口；
3. Rust 能取得 Server 端口与口令，WebView 能建立连接；
4. Rust attach 后 Server 能通过当前 Narrative Client 调用 Python；
5. Desktop 退出后两个子进程均被回收。
