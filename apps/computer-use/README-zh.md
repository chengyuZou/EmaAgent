# Windows 电脑操控程序

[English](README.md)

`ema-computer-use.exe` 是本机 Server 使用的原生程序. 通过继承的管道收发逐行 JSON-RPC, 不监听网络端口. Node 包管理 Session 归属, 这里负责 Windows 操作和桌面提示条.

## 实现职责

- `windows/capture.rs`: 使用 Windows.Graphics.Capture 和 D3D11 捕获窗口或主显示器, 编码为 PNG, 不绘制鼠标指针.
- `windows/accessibility.rs`: 有界读取 UI Automation 控件, 原生控件引用保留在执行线程. 无法读取时返回不完整列表, 仍可获取截图.
- `windows/observation.rs`: 将观察绑定到控制, 窗口, 截图尺寸和控件. 用户介入或滚动使旧观察失效, 每次动作也消耗当前观察.
- `windows/input.rs`: 激活并核对窗口后执行鼠标, 有限时长拖拽, Unicode 输入, 组合键和可用控件操作. 中断可能已有部分效果, 不自动重放.
- `windows/inputMonitor.rs`: 监听整个桌面的真实鼠标左/右/中键按下和键盘输入. 自己注入的输入带有标记, 不触发暂停. 鼠标移动和转动滚轮不暂停, 滚轮仍使观察失效. 钩子运行在独立线程上, 截图, 输入和提示条绘制都不会推迟键鼠响应.
- `windows/overlay.rs`: 创建不主动抢焦点的原生置顶窗口. 固定蓝色底, 白字, 蓝色光晕. 两行分别居中, 暂停时依次显示继续按钮, 继续快捷键提示, 结束按钮和 Esc 提示; 运行时显示 Esc 提示和结束按钮. 同一操控中每种状态和 DPI 只绘制一次, 操控结束前复用.

继续按钮和 Ctrl+Alt+C 在触发按键或按钮松开, 当前动作清理完成后恢复. Esc 和结束按钮只结束控制, 不取消聊天 Turn. 提示条请求从屏幕捕获中排除, 实际效果仍应在目标 Windows 环境验收.

管道读取, 提示条消息循环和键鼠钩子分别运行在各自的线程上, 不会等待执行线程的截图或输入完成. 结束时先拒绝新输入, 再等活动操作收尾并回答结束请求. stdin 关闭时停止输入并关闭提示条. 重启不恢复旧控制.

## 构建和验证

在仓库根目录运行:

```sh
node apps/desktop/scripts/buildComputerUse.mjs
cargo test --locked --manifest-path apps/computer-use/Cargo.toml
```

构建脚本把程序复制到 `src/computer-use/bin/`. `pnpm dev:start` 在启动 Tauri 开发环境前构建, `pnpm release` 在组装 Server 资源前构建发布程序. 其他平台保留原有截图路径, 不开放 Windows 操控.

真实桌面测试会打开自己的临时编辑窗口, 只向该窗口输入:

```sh
cargo test --locked --manifest-path apps/computer-use/Cargo.toml native_desktop_round_trip -- --ignored --nocapture
```

测试覆盖真实窗口截图, UI Automation, 中文输入, 暂停后旧观察失效和结束后拒绝动作, 不写用户文件. 真实键鼠接管, 混合 DPI, 多显示器, 安全桌面和第三方应用仍需要桌面验收.
