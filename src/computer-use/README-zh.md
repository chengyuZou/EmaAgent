# 电脑操控

[English](README.md)

本包连接 Node Server 和随包的 Windows 电脑操控程序. Server 共用一个 `ComputerUse`, 控制属于 Session, 使用首次观察调用的 ToolCallId 作为 `controlId`. 正常 Turn 完成不释放控制.

## 调用与暂停

主 Turn 在电脑工具入队时调用 `registerCall`, 返回的函数在调用完成后清理记录. 记录只保存控制归属和作废原因, 不转发工具操作.

首次 ObserveWindow 在 Permission 之前预约控制, 同时绑定该 Session 已入队的调用, 包括 ComputerEnd. 批准后才启动原生控制. 后续调用复用控制, 不重复弹 Permission; 整个工具的 deny 仍有效. 启动被拒绝时释放预约, 同批其余调用一起作废.

用户暂停时:

- 尚未提交原生请求的电脑调用立即返回未执行结果.
- 已提交的原生动作停止剩余步骤, 返回真实结果, 包括可能部分完成的输入.
- 主 Agent 在开始其他工具或下一次模型请求前等待. 已开始的非电脑操作可以收尾.
- 继续只允许新的观察和动作, 不恢复任何作废调用.

消息队列启动同 Session 的新 Turn 时也检查这个暂停状态. 等待不依赖旧工具或旧 Turn 是否仍在运行. 子代理不提供电脑工具, 也不接入主 Agent 的暂停等待.

Esc, 提示条结束按钮和 ComputerEnd 只结束电脑控制, 不取消 Turn. 结束时作废未完成的电脑调用, 等原生收尾后解除主 Agent 的等待. 聊天停止, Session 删除和应用关闭也会清理控制. 用户结束后, 新用户文本或 AskUser 回答只允许再次提出启动申请, 不授予 Permission 或恢复旧调用.

## 原生通信与截图

`NativeComputerProcess` 通过继承的 stdin/stdout 管道收发逐行 JSON-RPC. 请求编号匹配回应, `computer.stateChanged` 独立通知 running, paused, ending 和 ended 状态. 取消已发出的请求仍等待原生回应, 保留部分执行情况. 超时结束原生进程, 不回放输入.

开发和发布构建均将程序复制到本包的 `bin/`, 运行时只从这里加载. 缺少构建产物时明确报告启动错误. 安装后无需另装 Rust, Python 或 Node.

`capture(signal)` 直接请求 PNG 字节, 不启动电脑控制. Server 将它提供给[自动截图](../vishot-capture/README-zh.md)和 CaptureTool, 两者继续使用现有附件保存流程. ObserveWindow 直接在工具结果里返回窗口图片和控件, 不另外创建附件文件. [原生程序](../../apps/computer-use/README-zh.md) 负责 Windows 捕获, 输入, 控件和提示条.

## 接入与验证

[Turn](../turn/README-zh.md) 通过执行环境的 `onToolRegistered` 登记电脑调用, 通过 `beforeToolExecution` 接入共享等待. [工具执行器](../tools/README-zh.md) 只处理单调用取消, 执行前等待和登记清理, 不解释电脑状态. [内置工具](../builtin-tools/README-zh.md) 直接按 ToolCallId 调用 ComputerUse.

运行 `pnpm --filter @ema-agent/computer-use test`. 测试使用模拟原生连接. Tool 和 Turn 集成测试覆盖同批启动结束, 暂停立即返回, 普通工具等待和 Session 复用. 真实桌面交互仍需原生测试.
