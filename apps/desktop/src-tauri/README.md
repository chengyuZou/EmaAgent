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
| `set_passthrough` | `{ value }` | `Result<(), String>` | `setPassthrough(value)` | 设置 main 的点击穿透模式, 并发送模式事件 |
| `get_passthrough` | 无 | `bool` | `getPassthrough()` | 查询本次进程中的 main 穿透模式初值 |
| `start_pet_pointer` | 无 | `Result<(), String>` | `startPetPointer()` | 为 main 启动唯一的原生系统鼠标采样任务 |
| `set_passthrough_controls_hovered` | `{ hovered }` | `Result<(), String>` | `setPassthroughControlsHovered(hovered)` | 穿透模式内临时恢复控制区点击, 不改变模式 |
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

桌宠浮动菜单开启 / 关闭 main 的点击穿透模式. 角色继续显示, 非控制区的点击落到后面的窗口. FloatingDock 按系统坐标命中菜单, 权限提示和通知控制区, 通过 `set_passthrough_controls_hovered` 临时恢复点击; 离开后继续穿透. 模式和置顶独立, 开启穿透时不执行未置顶窗口的失焦自动最小化. 托盘的 "关闭点击穿透" 调用同一模式入口, 解除最小化并显示 / 聚焦 main. 模式不持久化, 不改变 chat / settings 的交互.

## 系统鼠标与穿透事件

事件只发给 main. 原生生产者是 `desktop/petPointer.rs` 和 `desktop/windows.rs`, WebView 只经 `tauri-bridge.ts` 的具名方法订阅.

| 事件 | Payload | 前端方法 | 实际消费者 |
|---|---|---|---|
| `ema://pet-pointer` | `{ type: "position", clientX: number, clientY: number, inside: boolean }` 或 `{ type: "error", message: string }` | `listenPetPointer(handler)` | CharacterStage 的 Live2dResource 直接驱动当前模型视线; FloatingDock 更新显隐及控制区命中 |
| `ema://pet-passthrough` | `boolean` | `listenPassthrough(handler)` | FloatingDock 展示原生穿透模式, 包含托盘发起的关闭 |

`clientX/clientY` 是相对 main 内容区左上角的 CSS 逻辑坐标, 允许位于窗口外; 原生已扣除 `inner_position` 并除以窗口缩放系数. `inside` 表示是否在内容区内, 不表示命中模型像素或控制区.

FloatingDock 在订阅就绪后调用一次 `startPetPointer()`. Rust 按 60Hz 目标间隔在原生主线程读取系统鼠标与窗口位置, 忙时跳过错过的 tick, 不堆积主线程采样. Live2D 与窗口交互共用这份采样, 前端不轮询. 隐藏 / 最小化时跳过坐标读取与推送, 恢复后继续; HMR 重新启动采样时取消旧任务, 应用退出时停止任务. 平台坐标接口不可用时启动失败; 运行中的坐标采样失败时原生尝试关闭穿透并发送 error, Dock 提示错误并禁用穿透按钮.

模式只从原生事件更新, 初值查询不覆盖查询期间已收到的新模式. 迟到的控制区报告也只能依据原生当前模式临时恢复点击, 不能重新开启托盘已关闭的模式.

原生 Command, 采样任务和托盘的变更需要重新编译并重启 Tauri Host 才能验收; 前端 HMR 不会更新现有原生进程. 本次按用户约定只核对源码调用链, 未运行测试 / typecheck, 未操作 dev 或重启宿主, 不把此记录当成运行验收.

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
