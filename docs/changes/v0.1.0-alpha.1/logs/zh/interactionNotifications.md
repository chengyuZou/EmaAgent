# Windows Permission 和 AskUser 通知

[English](../en/interactionNotifications.md)

## 行为

Permission 和 AskUser 改用 Windows 原生通知, 移除舞台的 `PermissionToastLayer`. 原有聊天交互卡片仍可使用. 不新增后端回答 API, 权限规则或持久化交互队列.

只有 main 在前台, 且 Chat 正显示请求所属 Session 时才不弹原生通知. 查看其他 Session, Settings, main 在后台或最小化时都可以收到. 每个 Session 只展示 Permission 与 AskUser 混合队列的队首, 不同 Session 可以独立通知.

Permission 提供允许, 本会话允许和拒绝. 三个按钮复用已有 Session WebSocket 答复入口, 收到后端 resolved 事件后才移除等待状态. AskUser 只有关闭按钮, 答案仍在 Chat 中填写. 点击通知正文打开原 Session. 关闭按钮和系统 X 只关闭提示, 不结束请求.

已回答, 取消或超时的请求会移除对应 Windows 通知及通知中心记录. 已关闭的通知不因普通状态刷新再次弹出. 前端拒绝过期或非队首批准, 同一次原生答复提交期间忽略重复点击. 断线时点击会打开 Chat, 不暗中排队批准.

## 实现边界

- main 观察现有活动与导航 Store, 经具名 Tauri 方法同步原生展示, 并建立点击回传 Channel.
- Rust MTA 线程串行处理 Windows 通知注册, 展示和移除. COM 激活回调只返回动作和已有通知身份, 前端与后端仍检查请求是否有效.
- Debug 和 release 使用不同的当前用户通知身份. 注册键为应用专用的易失键, 正常退出清理, 启动时清理遗留通知.
- Windows 负责外观及横幅是否可见, 保留系统通知设置和勿扰模式的作用. 不需要自定义 CSS 窗口或管理员注册.
- macOS 和 Linux 保留应用内交互 UI, 这条原生通道仅在 Windows 启用.

## 验证

定向前端测试覆盖混合队列队首, Session 导航, 三种 Permission 答复, Ask 仅导航不回答, 过期与重复点击, IPC 串行同步, 重连, 断线点击, 以及初始化未完成时卸载. 原有子代理消费测试也通过.

默认原生测试检查 XML 转义, 按钮动作, 激活参数校验, 并实际完成 Windows COM 类工厂与点击回调往返, 不展示横幅.

另有需显式开启的 Windows 投递测试, 使用真实注册和发送函数, 配合隔离的通知身份, 测试专用 COM 类和临时图标. 它检查通知历史及异步失败, 随后清理自己的通知和注册. 会展示约三秒的无业务效果横幅, 任何按钮都不批准真实工具. 用户已确认看到隔离测试的横幅. 这不代表 Ema 完整 UI 答复链路或安装版已经验收.

前端类型检查与原生编译已通过.

## 设置查询阻断投递

2026-10-20, 真实发送函数在执行 `Show` 前失败, 原因是 `ToastNotifier.Setting()` 前置检查返回 `0x80070490` (`ERROR_NOT_FOUND`). 这不是通知 XML 缺少子节点或 Tauri capability 拒绝的证据. 使用相同的注册和载荷构造代码, 直接投递给 Windows 则成功, 通知历史中有一条记录.

回归测试先调用应用原来的发送函数, 确认因上述 HRESULT 失败. 移除 `Setting()` 前置条件后, 同一个测试通过, 没有异步失败, 通知历史中有一条记录. Windows 在投递时仍应用自身通知设置和勿扰模式, 应用没有绕过这些规则.

在仓库根目录显式运行 Windows 检查:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib windows_accepts_a_real_notification -- --ignored --nocapture
```

此前的 XML 对象和 COM 测试没有经过这道前置检查, 也不能证明投递成功. 新测试覆盖该原生边界, 不启动 Server 或读取用户目录. 没有改动 Tauri capability 配置.

## 待验收

先重新编译并重启 Tauri 宿主, 再验证当前 Session 不弹, Ema 在前台但查看另一 Session, Settings, 后台与最小化, Permission 三个按钮, 两类关闭入口, 正文导航, 取消与超时清理, 带子代理的混合队列, 以及完整退出. 还需检查通知中心, Windows 通知设置和安装版身份. 仅靠前端 HMR 不会更新原生实现.
