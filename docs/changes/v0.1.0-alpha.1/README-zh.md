# 0.1.0-alpha.1

[English](./README.md)

状态: 草稿, 尚未发布. 安装版验收仍待完成.

这个 Alpha 将角色对话和本地 Agent 工作放在同一个桌面应用中. 使用依赖模型的功能前, 需要配置对应的模型服务来源.

## 已有能力

- 创建角色, 配置人设, 立绘或 Live2D 模型, 以及参考音频.
- 管理独立对话和项目, 添加文件和图片附件, 查看流式回复与工具结果.
- 在所选权限范围内, 让 Agent 使用文件, 命令, 网页搜索, Task, Goal 和子代理.
- 在对话旁打开文件, Git 变更, 浏览器标签页和终端.
- 配置 LLM, Vision, Embedding, Rerank, TTS 和 STT 模型, 通过 Skills 和 MCP 扩充工具.
- 使用文件形式的长期 Memory, 并通过独立的 Narrative 检索内置故事设定.
- 导出和导入单个对话及其可用的托管文件.

## 已包含的修复

- Live2D 可以在发布版内容安全策略下加载, 无需开启 JavaScript `unsafe-eval`. [问题记录](./logs/zh/live2dReleaseRendering.md).
- 最小化或隐藏舞台不再让 Ema 主动停止 Live2D ticker. 浮动控件仍随窗口可见性变化.
- 文件树, Diff 和终端可以在发布版中应用运行时样式. Markdown 允许网络图片, 保留本地与网络音频播放. [问题记录](./logs/zh/releaseUiStyles.md).
- 两个应用窗口都获得修改原生主题的权限. 安装版 Server 使用生产环境的 Node 配置启动. [问题记录](./logs/zh/releasePermissionsAndEnvironment.md).
- 选择跟随系统时, 解除此前的亮色或暗色窗口覆盖, 不再把该覆盖误认为系统偏好. [问题记录](./logs/zh/releasePermissionsAndEnvironment.md#跟随系统主题回归).
- Windows 进程清理不再让清理命令显示控制台窗口. 用户确认测试过的 Windows 安装版能够完整退出, 没有此前报告的闪现. [问题记录](./logs/zh/windowsExitConsole.md).
- Skills 安装和 MCP 市场添加在切换设置页后保留进行中状态, 支持同时操作多个目标. 源码检查和 Dev 验收通过, 安装版仍待验收. [问题记录](./logs/zh/marketOperationNavigation.md).

屏幕捕获设置已有独立侧栏页面, 包含原有的自动捕获开关, 间隔和隐私提示.

## 使用这个 Alpha 前

- 安装与操作系统和 CPU 架构匹配的包. Windows `.exe` 不是 macOS 或 Linux 安装包.
- 依赖模型的功能需要对应的服务来源和模型绑定. 外部请求可能产生费用.
- 开发版与安装版默认使用同一个用户数据目录. 启动另一个之前先退出当前应用, 或通过独立的 `EMA_PROFILE_DIR` 测试.
- 当前修复完成后仍需统一进行安装版回归. 此前用户检查通过了 Windows 基础安装, 重复启动, 对测试版本的覆盖安装和退出, 但这些结果不代表所有升级路径都已验证. 测试升级前备份现有数据. 重新安装旧程序不会撤销数据库迁移.

## 排查记录

这些记录将证据和剩余检查与版本摘要分开保存. 先前安装包的准确构建标识未记录, Dev 通过不能代替统一的安装版回归.

- [设置切页后的市场操作状态](./logs/zh/marketOperationNavigation.md)
- [AskUser 提问前的额外审批](./logs/zh/askUserApproval.md)
- [发布版 Live2D 渲染](./logs/zh/live2dReleaseRendering.md)
- [发布版界面样式与 Markdown 媒体](./logs/zh/releaseUiStyles.md)
- [原生主题权限与 Server 环境](./logs/zh/releasePermissionsAndEnvironment.md)
- [Windows 退出时控制台闪现](./logs/zh/windowsExitConsole.md)
- [WebSearch 返回无关结果](./logs/zh/webSearchResults.md)
