# Desktop 原生宿主

[English](./README.md)

这个 Rust 包负责 Ema 的原生窗口和桌面能力. 它创建角色舞台与聊天窗口, 启动本地 Server, 并提供浏览器面板, 终端, 托盘菜单, 文件选择和系统鼠标跟踪.

## 启动与用户数据

`lib.rs` 注册 Tauri 插件和命令. 应用先显示 `stage` 角色舞台, 用户打开聊天时才创建 `main` 窗口.

启动 Server 前, 宿主先准备随包模型目录和角色资源. 默认用户目录是 `~/.ema-agent`, 可用 `EMA_PROFILE_DIR` 覆盖. 已有 `profile.db` 时不再补种内置角色; 模型目录只在文件缺失时复制. 正式版安装位置不会另建一份用户数据.

```mermaid
sequenceDiagram
    participant Host as Rust 宿主
    participant Server as 本地 Server
    participant Stage as stage WebView
    Host->>Host: 准备随包资源
    Host->>Server: 带 EMA_SHARED_SECRET 启动
    Server->>Server: 初始化数据并监听
    Server-->>Host: server.ready 通知端口
    Stage->>Host: get_server_port / get_server_secret
    Host-->>Stage: 当前连接信息
    Stage->>Server: 带认证的 HTTP, SSE 和 WebSocket 请求
```

Server 自行选择本机端口. 宿主最多等待 120 秒收到就绪通知, 同时检查进程是否提前退出. 开发时 `tsx watch` 重启 Server 可能换端口, 后续就绪通知会更新宿主保存的连接信息.

开发版从仓库启动 `pnpm --filter @ema-agent/server dev`. 正式版启动随包的 `ema-server`, 它是为发布重命名的 Node, 工作目录为 `server/app`, 入口参数为 `./dist/main.js`. 安装目录里的 `server` 包含运行所需代码与依赖, 不能删除.

宿主为 debug 构建设置 `NODE_ENV=development`, 为 release 构建设置 `NODE_ENV=production`. Release 子进程不继承 `NODE_OPTIONS` 和 `NODE_PATH`. 这与发布准备检查一致, 避免终端中的 Node 设置改变安装版 Server 的启动方式.

Windows 上, `processes/webProxy.rs` 在启动 Server 前读取当前用户的 WinHTTP/Internet Options 代理配置. 固定代理地址, 例外规则及自动配置/读取失败标记通过 `EMA_WEB_SYSTEM_PROXY` 交给 Server, 只有网页工具消费. 宿主不设置 `HTTP_PROXY`, 也不修改系统设置. 代理选择和支持范围见 [Builtin Tools](../../../src/builtin-tools/README-zh.md#网页-已有资料与子-agent). 原生宿主修改需要重新构建并重启.

## 页面内容策略

`tauri.conf.json` 允许 Markdown 的 HTTP 和 HTTPS 图片与音频, 以及应用需要的本地和 Blob 媒体. JavaScript 的 `unsafe-eval` 仍然关闭; Cubism 使用的 WebAssembly 权限单独保留.

只有 `style-src` 关闭 Tauri 的自动 CSP 加工. 文件树, Diff 和 xterm 会在运行时创建 style 元素. 向该指令加入 nonce 后, 浏览器会忽略其中的 `unsafe-inline`, 导致这些元素被拒绝. 其他指令仍由 Tauri 正常加工. 两个应用窗口的 capability 另外授予 `core:window:allow-set-theme`, 用于修改原生窗口主题.

## 窗口与事件

- 关闭聊天窗口只隐藏窗口, 不销毁 WebView, 已提交的会话工作继续运行.
- 舞台在点击穿透时仍可跟踪系统鼠标, 托盘菜单可以恢复普通交互.
- 系统事件和舞台控制通过具名 Tauri 事件传递. 前端入口是 [tauriBridge.ts](../src/lib/tauri/tauriBridge.ts), 载荷类型在 [types.ts](../src/lib/tauri/types.ts).
- 外部浏览器面板是独立的子 WebView, 由前端控制位置和显隐. 网页请求新窗口时交给系统浏览器.
- 自有应用窗口使用 `desktop/windows.rs` 配置的 Windows WebView2 媒体设置. 不为外部浏览器面板授予这些应用权限.

## Windows 交互通知

主 WebView 观察现有 Session 交互队列, 只把各队列的队首通过 `sync_interaction_notifications` 交给宿主. `connect_interaction_notifications` 建立原生点击回传的 IPC Channel. 两个命令只接受 `main` 调用. 原生实现在 `desktop/interactionNotifications.rs`, 使用 Windows Toast API 和 COM 激活回调, 不创建另一套 WebView 或 CSS 页面.

Rust 将 main 的句柄与 Windows 前台窗口比较. 只有 main 在前台, 且 Chat 正显示请求所属 Session 时, 才不弹通知. 查看其他 Session, Settings, 隐藏 main 或前台是其他应用时都可以收到通知. 已经展示过的通知不会因为普通 Store 刷新或被关闭而重复弹出.

Permission 提供允许, 本会话允许和拒绝. main 再次检查交互队首, 通过与聊天卡片相同的 Session WebSocket 入口提交. AskUser 只有关闭按钮, 答案仍在 Chat 中填写. 点击两种通知的正文都会打开原 Session 的 Chat. 关闭按钮和系统 X 只关闭通知, 不回答, 不拒绝, 也不取消等待中的请求.

已回答, 取消或超时的请求离开前端队列后, 对应 Windows 通知和通知中心记录也会移除. 断线时点击批准会返回 Chat, 不暗中排队提交答案. 原生通知失败不影响聊天卡片继续处理. Windows 通知设置和勿扰模式可能抑制横幅, 这不是一个始终置顶的应用窗口.

独立 MTA 线程负责原生注册, 展示与移除. 建立通道时传入 main 窗口句柄, UI 线程等待退出时, 通知线程不会再调用 Tauri 窗口 getter. Debug 与 release 使用不同通知身份. 注册只使用当前用户 `Software\Classes` 下本应用专用的易失注册表键, 图标放在应用缓存中. 正常退出移除通知与注册键; 启动时清理遗留通知, 因为后端交互等待不能跨进程重启恢复. 不修改系统通知偏好, 也不需要管理员注册. macOS 和 Linux 保留应用内交互 UI, 不启用这条 Windows 通知通道.

## 原生命令

命令入口放在 `src/commands`, 具体实现使用 `src/desktop` 和 `src/processes` 中的模块.

| 前端操作 | 原生入口 |
| --- | --- |
| 读取 Server 连接信息 | `get_server_port`, `get_server_secret` |
| 显隐聊天, 退出, 舞台置顶和点击穿透 | `open_main_window`, `hide_main_window`, `quit_app`, `set_always_on_top`, 鼠标与穿透命令 |
| 读取本地图片字节用于草稿预览或壁纸上传; 检查附件路径 | `read_local_image`, `inspect_attachment_paths` |
| 选择聊天附件, 壁纸或角色资源路径 | `select_paths` |
| 连接原生交互点击回调, 同步待处理通知 | `connect_interaction_notifications`, `sync_interaction_notifications` |
| 打开本机路径和枚举字体 | `open_path`, `list_system_fonts` |
| 创建和控制浏览器面板 | `commands/browser.rs` 中的命令 |
| 打开, 写入, 调整和关闭 PTY 终端 | `commands/terminal.rs` 中的命令 |

终端的 Shell 候选由 Server 的 System API 探测, 不是 Tauri 命令. `open_terminal` 接收选中的 `shell: { kind, path }`, 终端尺寸, 工作目录和输出用的 IPC Channel. Rust 根据 `kind` 决定启动参数. 归档或删除会话会请求关闭它的 PTY, 普通切换会话则保留运行. 退出应用会关闭全部 PTY.

文件拖入使用 Tauri 的 WebView 拖放事件. 前端先把物理坐标换成页面坐标, 再检查当前页面和目标区域. 可见 Chat 的中间聊天区走草稿附件流程, 壁纸设置卡片走图片上传接口并由 Server 检查图片内容. 隐藏的 Chat 和其他设置页面不接收这些拖放. 侧栏 Session 排序是另一套页面交互.

`select_paths` 返回选中的路径, 取消时返回空数组. Windows 上不为选择框设置 owner, 让主窗口保持可交互; macOS 和 Linux 保留父窗口. 此入口同时只允许一个选择框等待结果, 即使等待结果的一方已释放, 也要等原生回调结束才能再次打开. 工作目录, 项目和 Data 备份选择框保持原入口.

调用方保留打开选择框时的目标. 聊天附件追加到原 Session 的最新草稿, 但原草稿进入提交后返回的选择结果会被丢弃. 参考音频表单关闭, 更换角色或提交后, 忽略之前尚未返回的选择. 壁纸只对实际操作排队, 不把等待选择框的时间算入队列; 导入时读取当前已保存的配置再合并图片.

## 退出与日志

正常退出时先移除交互通知及原生注册, 再销毁窗口, 关闭全部 PTY 并停止 Server 及其子进程. Windows 使用 Job Object 和进程树终止. macOS 与 Linux 使用独立进程组, 先发 TERM, 超时后再发 KILL.

启动日志写入用户目录的 `logs` 下. `logging.rs` 同时输出到终端, 并清理过期启动日志. Server stdout 同时包含启动消息和就绪通知, 由 `processes/child.rs` 区分协议消息与普通日志.

## 从哪里看与如何验证

先看 `lib.rs`, Server 启动看 `processes/desktop_processes.rs`, 窗口行为看 `desktop/windows.rs`. 修改 IPC 时需要一起核对前端具名方法, Rust 命令参数和命令注册.

在仓库根目录运行:

```sh
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

代理测试在 `tests/processes/webProxy.rs`. 默认测试检查 JSON 契约. 被忽略的 `windows_proxy_is_passed_only_to_web_tools` 只读取当前用户设置, 不修改配置. 构建 Builtin Tools 后, 被忽略的 `windows_web_fetch_reaches_public_site` 把这些设置传给 Node 并请求公开的 Brave 首页. 它只报告 HTTP 状态, 不输出页面正文或代理凭据, 区分 HTTP 错误和连接失败. 两个测试都不启动 Server 或打开用户数据库.

默认 Rust 测试覆盖资源准备, 启动日志内容和过期清理, 路径选择状态, 通知 XML 和动作校验, 以及不展示通知的 Windows COM 点击回调往返. Windows 另有需要显式开启的投递检查:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib windows_accepts_a_real_notification -- --ignored --nocapture
```

该检查使用真实注册和发送函数, 配合临时通知身份和图标. 它展示约三秒的无业务效果通知, 检查通知历史及异步失败, 然后清理自己的通知和注册. 任何按钮都不批准真实工具. `ToastNotifier.Setting()` 不作为投递前提: 对 `Show` 能接受的桌面通知身份, 该查询仍可能返回 `ERROR_NOT_FOUND`. Windows 在发送时依然应用系统通知偏好.

这些检查不能代替前台切换, 完整 UI 答复, WebView 输入, 原生选择框交互, 文件拖入, 浏览器显隐和 PTY 交互验收. 这些操作用 `pnpm --filter @ema-agent/desktop tauri:dev` 检查. 原生窗口行为改动需要重启宿主, 只靠前端 HMR 不会生效. 发布准备和安装包命令见 [Desktop README](../README.md).
