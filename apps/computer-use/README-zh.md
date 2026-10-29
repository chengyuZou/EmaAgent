# 原生电脑操控

[English](README.md)

Windows 程序负责窗口枚举, 窗口和显示器截图, UI Automation, 键鼠输入和操控提示层. Node 管理 Turn 身份与启动批准. 请求由 stdin 进入, JSON-RPC 回应和状态事件由 stdout 返回.

键鼠钩子, 请求执行, 管道读取和提示层分别运行在线程上. 物理 Esc 结束操控. 用户在目标窗口打字, 点击或滚动时使旧观察失效, 不改变操控状态. 注入输入不作为用户操作. 动作检查观察版本, 窗口身份和位置; 中断后松开已按住的键鼠, 并报告是否可能产生部分效果.

观察时尝试恢复并前置目标窗口. 前置失败与图像捕获分开报告. 输入前必须激活目标, 并检查键盘焦点或目标位置. 每次动作完成都消耗当前观察, 后续动作需要新观察.

提示条使用蓝底白字和结束按钮, 四角静态光晕跟随前台窗口所在的显示器. 光晕不拦截鼠标. 同 DPI 下复用图像, 维护位置和置顶顺序时不抢焦点. 这不能保证覆盖安全桌面或所有争夺置顶的程序. 提示层请求从捕获中排除.

结束时拒绝新输入, 等活动请求收尾, 再发送 ended 并回答结束请求. stdin 关闭同样结束操控并关闭原生 UI. 进程重启不恢复旧控制.

## 构建和验证

在仓库根目录运行:

```sh
node apps/desktop/scripts/buildComputerUse.mjs
cargo test --locked --manifest-path apps/computer-use/Cargo.toml
cargo test --locked --manifest-path apps/computer-use/Cargo.toml native_desktop_round_trip -- --ignored --nocapture
```

被忽略的桌面测试创建自己的临时编辑窗口, 验证截图, 控件, 文本输入, 观察失效和结束处理, 不写用户文件. 真实键鼠钩子, DPI 变化, 置顶程序和多显示器仍需手动验收. Windows 程序嵌入 assets/icons/icon.ico. 其他平台保留现有截图路径.
