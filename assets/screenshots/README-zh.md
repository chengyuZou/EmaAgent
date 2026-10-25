# 截图素材

[English](./README.md)

这里保存根 README 使用的未修改实机原图. README 中点击图片可以查看原尺寸. 自定义角色采用桃濑日和模型和自定义聊天人设. 现有素材也包含一条 23 图消息收起和展开的画面.

39 张图片均已放入根 README. 补充界面画面和 4 张服务账单参考放在折叠区域, 本索引按用途列出全部图片.

| 目录 | 内容 | 图片数 |
| --- | --- | --- |
| `characters/` | 主界面与日和对话 | 4 |
| `conversation/` | 附件, 多图, 消息排队与审批通知 | 8 |
| `tasks/` | T2 研究与子代理记录 | 5 |
| `workspace/` | 文件, 审阅, 终端, 浏览器及工具入口 | 5 |
| `extensions/` | Skills 与 MCP | 4 |
| `settings/` | 外观与模型服务 | 7 |
| `usage/` | 应用用量及服务账单参考 | 6 |

## 主展示选图

| 文件 | 展示内容 |
| --- | --- |
| [mainWindow.png](./characters/mainWindow.png) | 对话, 壁纸, Live2D Stage 与表情表现 |
| [hiyoriCharacter.png](./characters/hiyoriCharacter.png) | 自定义角色在 Stage 中与用户聊自己的兴趣 |
| [messageImagesCollapsed.png](./conversation/messageImagesCollapsed.png) | 23 图消息收起为两行, 其他附件引用和已完成的 Skill 加载 |
| [messageImagesExpanded.png](./conversation/messageImagesExpanded.png) | 同一组的全部 23 张图片缩略图展开 |
| [task2Process.png](./tasks/task2Process.png) | 研究对话与已完成的子代理记录 |
| [task2Result.png](./tasks/task2Result.png) | 研究结论与修订版本, 引用对应表 |
| [task2SubagentResult.png](./tasks/task2SubagentResult.png) | 子代理返回的依据 |
| [workspaceFiles.png](./workspace/workspaceFiles.png) | 文件导航与 Markdown 预览 |
| [workspaceReview.png](./workspace/workspaceReview.png) | 对话旁的文件变更审阅 |
| [inputQueue.png](./conversation/inputQueue.png) | 工具执行时排队的两条补充输入 |
| [mcpCall.png](./extensions/mcpCall.png) | 实际外部 MCP help 调用及回复 |
| [skillsMarket.png](./extensions/skillsMarket.png) | 技能市场浏览 |
| [skillsMenu.png](./extensions/skillsMenu.png) | 会话中的技能选择 |
| [mcpServers.png](./extensions/mcpServers.png) | 已连接的 MCP 服务器与发现的工具 |
| [usageCache.png](./usage/usageCache.png) | 单次调用 Token, 服务报告的缓存用量及耗时 |
| [appearancePalette.png](./settings/appearancePalette.png) | 主题色相, 色阶与预设 |
| [providerLLM.png](./settings/providerLLM.png) | 在线与本地 LLM 服务预设 |
| [providerRetrievalSpeech.png](./settings/providerRetrievalSpeech.png) | 分别配置 Embedding, Rerank 和 TTS, 包含本地 GPT-SoVITS 入口 |

## 补充画面

- 自定义角色: [首轮回复](./characters/hiyoriOverview.png), [后续对话](./characters/hiyoriConversation.png).
- 附件: [输入框中的 25 个待发送附件及选中的 Skill](./conversation/attachmentDraft.png).
- 研究过程: [概览](./tasks/task2Overview.png), [子代理输入](./tasks/task2SubagentInput.png).
- 工作区: [工具入口](./workspace/workspaceTools.png), [手动终端](./workspace/workspaceTerminal.png), [空白浏览器标签](./workspace/workspaceBrowser.png), [附件列表](./conversation/attachmentPanel.png).
- 交互: [等待处理](./conversation/inputQueuePending.png), [后续回复](./conversation/inputQueueDelivered.png), [PowerShell 审批通知](./conversation/permissionNotification.png).
- 用量: [较早的调用记录](./usage/usageCacheEarlier.png).
- 外观: [字体](./settings/appearanceFonts.png), [圆角与代码配色](./settings/appearanceCodeStyle.png), [壁纸设置](./settings/wallpaperOptions.png), [壁纸透明度预览](./settings/wallpaperOverlay.png).

研究侧栏包含最初按日期分组的调查及后续复查, 总数不只最初三个分组. MCP 调用只展示帮助内容读取, 不代表已注册账号或发送邮件. 空白终端和浏览器只展示可用界面, 不代表已完成命令或页面浏览.

模型服务截图展示配置入口与预设, 不表示所有列出的服务都已配置或经过实测.

## 服务账单参考

[上午](./usage/providerUsageMorning.png), [下午](./usage/providerUsageAfternoon.png), [较晚的下午](./usage/providerUsageLateAfternoon.png)和[傍晚](./usage/providerUsageEvening.png)是外部服务后台画面. 日期, API Key 筛选及小时合计不等于按 Session 统计的单题用量. 不用这些图直接宣称 T2 费用, 整个应用的固定缓存率或产品对比结论.

PNG 均与提供的原文件逐字节一致. 公开分发前检查本机用户名, 路径, 机器名与账户标签, 不公开凭据.

现有 Skill 案例展示的是加载技能说明, 不表示已经用该技能完成任务. 多图截图展示历史消息布局, 不表示模型已经理解全部图片.

