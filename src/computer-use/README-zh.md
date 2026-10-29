# 电脑操控

[English](README.md)

本包连接 Node Server 与随包提供的 Windows 原生程序. 共享的 ComputerUse 同时只允许一个 Session 的一个 Turn 操控电脑. 首次观察的 ToolCallId 成为 controlId, 同一 Turn 内跨 Loop 保持不变. 每种 Turn 结束路径都先关闭操控, 再发布终态.

## 调用和批准

Turn 在电脑工具排队前调用 registerCall. 返回的清理函数删除调用记录, 启动未获批准时也释放预约. ObserveWindow 在 Permission 前预约电脑, 批准后启动操控. 后续动作复用本次操控. 用户可选择本会话允许, 后续启动匹配 Permission 的会话规则; 这不让操控跨 Turn 存活, 也不批准 Shell 或 MCP.

Rust 检测用户在目标窗口的实际输入, 使旧 observationId 失效. 没有暂停状态或继续等待. 旧动作尚未开始时返回未执行, 已开始时返回可能部分完成, Agent 重新观察再决定下一步.

Esc, 提示条结束按钮和 ComputerEnd 只结束操控, Turn 仍可继续汇报. Node 取消尚未提交的电脑调用, 已提交的请求返回 Rust 的实际结果. 普通工具不受影响. 用户明确结束后, 新用户文本或 AskUser 回答才允许再次申请启动, 旧调用不会复活. endTurn 按精确 Turn 身份清理, 避免迟到的收尾关闭另一 Turn 的操控.

## 通信和截图

NativeComputerProcess 通过 stdin/stdout 交换逐行 JSON-RPC. requestId 匹配回应, computer.stateChanged 通知 running, ending 和 ended. ending 表示拒绝新输入, 正在松开键鼠并等待原生操作收尾. 请求取消等待原生结果, 超时不重放输入.

构建程序复制到 bin/. 安装用户无需单独安装 Rust, Python 或 Node.

capture(signal) 返回 PNG 字节, 不启动操控. Server 将它交给自动截图和 CaptureTool, 定时与附件保存仍由原业务负责. ObserveWindow 直接返回窗口图像和控件, 尝试前置失败时可携带 activationError 返回图像. ComputerAction 在输入前再次检查目标.

相关说明见[原生程序](../../apps/computer-use/README-zh.md), [Turn](../turn/README-zh.md)和[工具执行](../tools/README-zh.md). 现有测试使用模拟连接, 真实桌面验证需要可交互的 Windows 环境.
