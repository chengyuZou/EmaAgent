<p align="center">
  <img src="assets/icons/icon.png" width="112" height="112" alt="EmaAgent 图标">
</p>

<h1 align="center">EmaAgent</h1>

<p align="center">
  <strong>可以陪你聊天的桌面角色, 也是能够实际干活的 Agent.</strong>
</p>

<p align="center">
  <a href="CHANGELOG-zh.md"><img src="https://img.shields.io/badge/version-v0.1.0--beta.2-00ADB5?style=flat-square" alt="版本 v0.1.0-beta.2"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4C9A2A?style=flat-square" alt="MIT License"></a>
  <a href="apps/desktop/README-zh.md"><img src="https://img.shields.io/badge/Tauri-24C8D8?style=flat-square&amp;logo=tauri&amp;logoColor=000000" alt="Tauri"></a>
  <a href="apps/desktop/README-zh.md"><img src="https://img.shields.io/badge/React-20232A?style=flat-square&amp;logo=react&amp;logoColor=61DAFB" alt="React"></a>
  <a href="tsconfig.base.json"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=FFFFFF" alt="TypeScript"></a>
  <a href="apps/server/README-zh.md"><img src="https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&amp;logo=nodedotjs&amp;logoColor=FFFFFF" alt="Node.js"></a>
  <a href="src/live2d-react/README-zh.md"><img src="https://img.shields.io/badge/Live2D-EA7299?style=flat-square" alt="Live2D"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

EmaAgent 把通用角色扮演与文件编辑, 命令执行, 网页搜索和多步骤任务放在同一个桌面应用里. 为角色配置人设, 立绘或 Live2D 模型及声音, 然后用它聊天, 查资料, 处理本机项目里的工作.

这是面向单人使用的本地优先应用, 使用 Tauri, React 和本地 Node.js Server. 对话, 设置, 角色资源和记忆保存在自己的机器上, 模型服务由你选择和配置.

[![主对话, 壁纸与桌面 Live2D 角色](assets/screenshots/characters/mainWindow.png)](assets/screenshots/characters/mainWindow.png)

<p align="center">
  <a href="CHANGELOG-zh.md">更新记录</a>
  <a href="docs/README-zh.md">文档入口</a>
</p>

## 当前能力

### 角色与对话

- 配置角色人设, 立绘, Live2D 模型, 参考音频和表情包. 填写表情包描述后, 角色可在回复中选择图片.
- 配合对应模型使用文字聊天, 图片理解, 语音输入和语音输出.
- 管理不同的会话与项目, 查看流式回复和工具结果.
- 通过文件式 Work 和 Relationship Memory 跨会话保留工作记录及关系记忆.

角色扮演不限定于内置角色或某个作品. 需要相关设定时, 独立的 Narrative 检索可以查询魔法少女的魔女审判三个周目的剧情原文.

### 实际处理工作

- 读取, 搜索, 创建和编辑文件, 执行命令并查看输出.
- 通过启用的工具搜索网页和读取页面.
- Windows 下通过电脑操控工具观察窗口, 操作可用控件和键鼠. 按 Esc 或点击桌面提示条结束操控; 每轮对话结束也会关闭操控. 用户修改目标窗口后, 旧观察失效, 后续操作需要重新观察. 自动屏幕捕获跳过相同画面.
- 使用 Task, Goal 和子 Agent 处理需要多个步骤的工作.
- Turn 运行时继续提交消息, 排队等待或选择在迭代之间引导当前 Turn.
- 选择工具权限模式, 压缩较长的对话上下文, 查看模型用量记录.
- 在对话旁打开文件, Git 变更, 浏览器标签和手动终端.

文件和命令会影响你的机器. 请检查工具请求, 为任务选择合适的工作目录. 权限和命令隔离的具体行为取决于工具, 设置及操作系统, 不代表每个操作都没有风险.

### 接入模型和工具

- 分别配置 LLM, Vision, Embedding, Rerank, TTS 和 STT 的 Provider 与模型.
- 加载本地或项目 Skills, 也可以从 SkillHub 和 ClawHub 安装.
- 连接 MCP Server 来增加工具.
- 以 `.ema-session.zip` 导出和导入单个会话, 包括可读取的受管文件.

功能取决于启用的模型, 工具和本地资源. 本地优先不等于离线: Prompt, 图片, 工具结果或检索文字可能发送给配置的外部服务, 请求也可能产生费用.

## 界面与工作流

点击截图可查看原尺寸, 展开各功能下的折叠区域可查看更多画面. 图片展示软件的实际状态, 单个任务案例不代表完整 benchmark 评测结果.

### 自定义角色

为角色配置人设和立绘或 Live2D 模型. 下图使用 [Live2D 的桃濑日和示例模型](https://www.live2d.com/en/learn/sample/momose-hiyori/)和自定义聊天人设, 在对话旁的 Stage 展示角色.

[![桃濑日和在 Stage 中与用户聊自己的兴趣](assets/screenshots/characters/hiyoriCharacter.png)](assets/screenshots/characters/hiyoriCharacter.png)

<details>
<summary>查看更多日和对话</summary>

[![日和首轮回复及 Stage 中的角色](assets/screenshots/characters/hiyoriOverview.png)](assets/screenshots/characters/hiyoriOverview.png)

[![日和继续聊空闲下午的安排](assets/screenshots/characters/hiyoriConversation.png)](assets/screenshots/characters/hiyoriConversation.png)

</details>

### 角色表情包

在角色详情中批量导入图片, 填写名称与描述, 角色即可根据对话选择表情包. 描述为空的图片保留在资源库中, 不提供给模型. 图片网格便于浏览, 配置总览便于检查全部描述; 整段表情包说明上限为 80,000 字符.

聊天中以紧凑尺寸显示表情包, 点击查看原图. 删除资源后, 旧回复可能显示图片无法加载的占位图. 详情见[角色资源](src/characters/README-zh.md#表情包).

### 长任务与子代理

这个研究案例检查维基百科历史版本及其中引用的帖子. 对话保留任务, 工具调用和子代理记录, 右侧可以继续查看子代理详情.

[![研究对话与已完成的子代理任务](assets/screenshots/tasks/task2Process.png)](assets/screenshots/tasks/task2Process.png)

<details>
<summary>查看任务概览, 子代理输入与研究结果</summary>

[![研究任务的原始请求及初始工具调用](assets/screenshots/tasks/task2Overview.png)](assets/screenshots/tasks/task2Overview.png)

[![主对话旁展示发送给子代理的指令](assets/screenshots/tasks/task2SubagentInput.png)](assets/screenshots/tasks/task2SubagentInput.png)

[![带修订版本和引用计数的研究结果](assets/screenshots/tasks/task2Result.png)](assets/screenshots/tasks/task2Result.png)

[![主对话旁展示子代理返回的依据](assets/screenshots/tasks/task2SubagentResult.png)](assets/screenshots/tasks/task2SubagentResult.png)

</details>

### Windows 电脑操控

Agent 可以列出并观察窗口, 使用可用控件或键鼠操作桌面应用. 操控期间显示结束入口, 按 Esc 或点击结束可归还控制. 工具调用和结果保留在对话中.

这个示例中, Agent 操作浏览器中的视频播放器, 跳转多个时间点观察画面和可见字幕, 最后整理摘要.

[![结束电脑操控并汇总已观察的画面和字幕](assets/screenshots/workspace/computerUseVideoSummary.png)](assets/screenshots/workspace/computerUseVideoSummary.png)

<details>
<summary>查看窗口观察, 播放器操作与分时点记录</summary>

[![用户请求, 初次窗口观察和播放器操作](assets/screenshots/workspace/computerUseVideoStart.png)](assets/screenshots/workspace/computerUseVideoStart.png)

[![跳转视频进度并切换全屏](assets/screenshots/workspace/computerUseVideoNavigation.png)](assets/screenshots/workspace/computerUseVideoNavigation.png)

[![多个时间点的画面和可见字幕观察记录](assets/screenshots/workspace/computerUseVideoFrames.png)](assets/screenshots/workspace/computerUseVideoFrames.png)

</details>

### 对话旁的工作区

不离开会话即可浏览文件并阅读内容, 也能在右侧打开审阅, 手动终端和浏览器标签.

[![对话旁的项目文件树与 Markdown 预览](assets/screenshots/workspace/workspaceFiles.png)](assets/screenshots/workspace/workspaceFiles.png)

<details>
<summary>查看工作区审阅, 工具入口, 终端与浏览器</summary>

[![侧栏中的文件, 审阅, 子代理, 附件, 终端与浏览器入口](assets/screenshots/workspace/workspaceTools.png)](assets/screenshots/workspace/workspaceTools.png)

[![右侧面板展示文件变更](assets/screenshots/workspace/workspaceReview.png)](assets/screenshots/workspace/workspaceReview.png)

终端和浏览器截图展示尚未执行命令或打开页面时的界面.

[![对话旁的手动终端](assets/screenshots/workspace/workspaceTerminal.png)](assets/screenshots/workspace/workspaceTerminal.png)

[![对话旁的浏览器标签及地址输入框](assets/screenshots/workspace/workspaceBrowser.png)](assets/screenshots/workspace/workspaceBrowser.png)

</details>

### 图片与附件

一条消息可以同时包含多张图片及文件, 粘贴文本和 Skill 引用. 图片较多时, 历史消息默认保留两行缩略图, 可以展开查看完整图片组.

[![一条消息中的 23 张图片收起为两行, 下方保留其他附件引用](assets/screenshots/conversation/messageImagesCollapsed.png)](assets/screenshots/conversation/messageImagesCollapsed.png)

<details>
<summary>查看图片展开, 输入框附件与附件侧栏</summary>

[![同一条消息中展开全部 23 张图片缩略图](assets/screenshots/conversation/messageImagesExpanded.png)](assets/screenshots/conversation/messageImagesExpanded.png)

[![输入框中的 25 个待发送附件及选中的 Skill](assets/screenshots/conversation/attachmentDraft.png)](assets/screenshots/conversation/attachmentDraft.png)

[![附件侧栏列出会话中的图片](assets/screenshots/conversation/attachmentPanel.png)](assets/screenshots/conversation/attachmentPanel.png)

</details>

### 补充输入与权限

Turn 运行时可以继续提交需求. 排队输入可以留待后续 Turn, 删除或标记为迭代之间交付的引导, 不强行打断正在执行的工具.

[![工具运行时排队的两条补充消息](assets/screenshots/conversation/inputQueue.png)](assets/screenshots/conversation/inputQueue.png)

<details>
<summary>查看等待处理, 后续回复与桌面审批提醒</summary>

[![一条输入等待处理, 另一条仍在队列中](assets/screenshots/conversation/inputQueuePending.png)](assets/screenshots/conversation/inputQueuePending.png)

[![演示排队输入交付后的实际回复](assets/screenshots/conversation/inputQueueDelivered.png)](assets/screenshots/conversation/inputQueueDelivered.png)

[![PowerShell 工具请求批准时的桌面通知](assets/screenshots/conversation/permissionNotification.png)](assets/screenshots/conversation/permissionNotification.png)

</details>

### Skills 与 MCP 工具

从 SkillHub 和 ClawHub 浏览技能, 在会话中选择技能, 或连接 MCP 工具. 下图 MCP 案例实际调用的是外部服务器的 help 工具, 不代表已经执行邮件发送.

[![包含 SkillHub 和 ClawHub 条目的技能市场](assets/screenshots/extensions/skillsMarket.png)](assets/screenshots/extensions/skillsMarket.png)

[![外部 MCP help 调用, 返回内容与最终回复](assets/screenshots/extensions/mcpCall.png)](assets/screenshots/extensions/mcpCall.png)

<details>
<summary>查看技能选择入口与已连接的 MCP 工具</summary>

[![从会话菜单选择技能](assets/screenshots/extensions/skillsMenu.png)](assets/screenshots/extensions/skillsMenu.png)

[![已连接的 MCP 服务器与发现的工具](assets/screenshots/extensions/mcpServers.png)](assets/screenshots/extensions/mcpServers.png)

</details>

### 单次调用用量

查看模型输入/输出 Token 与调用耗时. 服务返回缓存用量时, 同一条记录还会显示缓存读取, 写入和读取命中率. 这些是各次调用由服务报告的数据, 不是固定缓存率或费用保证.

[![包含 Token, KV 读缓存及耗时的模型调用记录](assets/screenshots/usage/usageCache.png)](assets/screenshots/usage/usageCache.png)

<details>
<summary>查看同一用量页面中的较早调用</summary>

[![较早的模型调用及对应 Token, 缓存用量和耗时](assets/screenshots/usage/usageCacheEarlier.png)](assets/screenshots/usage/usageCacheEarlier.png)

</details>

<details>
<summary>查看服务后台用量与账单参考</summary>

以下为 DeepSeek 服务后台按所选日期, API Key 和小时汇总的用量画面, 可结合上方的应用内调用记录查看. 这些汇总没有按 Session 或单道任务拆分.

[![DeepSeek 服务后台的上午时段用量](assets/screenshots/usage/providerUsageMorning.png)](assets/screenshots/usage/providerUsageMorning.png)

[![DeepSeek 服务后台的下午时段用量](assets/screenshots/usage/providerUsageAfternoon.png)](assets/screenshots/usage/providerUsageAfternoon.png)

[![DeepSeek 服务后台较晚的下午时段用量](assets/screenshots/usage/providerUsageLateAfternoon.png)](assets/screenshots/usage/providerUsageLateAfternoon.png)

[![DeepSeek 服务后台的傍晚时段用量](assets/screenshots/usage/providerUsageEvening.png)](assets/screenshots/usage/providerUsageEvening.png)

</details>

### 外观定制

选择主题色相和调色预设, 也可以设置壁纸, 字体, 圆角及代码配色.

[![主题色相, 色阶和调色预设](assets/screenshots/settings/appearancePalette.png)](assets/screenshots/settings/appearancePalette.png)

<details>
<summary>查看字体, 代码配色与壁纸设置</summary>

[![分别配置 Markdown 正文字体和等宽字体](assets/screenshots/settings/appearanceFonts.png)](assets/screenshots/settings/appearanceFonts.png)

[![圆角设置与代码配色主题](assets/screenshots/settings/appearanceCodeStyle.png)](assets/screenshots/settings/appearanceCodeStyle.png)

[![壁纸预览及不透明度, 模糊设置](assets/screenshots/settings/wallpaperOptions.png)](assets/screenshots/settings/wallpaperOptions.png)

[![调整透明度后壁纸显示在设置界面背景中](assets/screenshots/settings/wallpaperOverlay.png)](assets/screenshots/settings/wallpaperOverlay.png)

</details>

## 开始使用

### 使用安装包

安装为当前操作系统构建的安装包, 然后启动 Ema. 安装目录中的 `server/` 是应用后端, 不是第二个应用, 需要与程序保存在一起. 安装包包含 Node 和正式依赖, 使用者不需要源码仓库或另装 Node.

1. 启动 Ema, 打开设置中的服务来源, 选择或添加 LLM 服务.
2. 填写该服务实际支持的协议, 地址及所需凭据. 自定义网关的协议由它提供的 API 决定, 不只看模型名称.
3. 添加或启用要使用的 LLM 模型, 在聊天中选择该服务与模型.
4. 选择角色, 新建聊天, 发送一句普通消息, 确认能够完成回复.

普通文字对话不要求先配置 Embedding, Rerank, TTS 或 STT. 先验证这一步, 再逐项启用需要的能力, 便于判断哪一项配置没有生效. 真实请求可能产生所选服务的费用.

如果没有可选模型, 先检查服务和模型是否已经保存并启用. 出现鉴权或协议错误时, 检查对应服务的地址, 凭据和协议, 不需要先删除聊天或重置数据.

<details>
<summary>查看模型服务配置界面</summary>

选择服务预设或添加自己的地址. LLM 服务来源列表包含 Ollama 和 LM Studio 等本地服务预设. Embedding, Rerank 和 TTS 分别配置服务来源, TTS 列表也提供本地 GPT-SoVITS 入口.

[![LLM 服务来源中的在线与本地服务入口](assets/screenshots/settings/providerLLM.png)](assets/screenshots/settings/providerLLM.png)

[![分别配置 Embedding, Rerank 和 TTS 服务来源](assets/screenshots/settings/providerRetrievalSpeech.png)](assets/screenshots/settings/providerRetrievalSpeech.png)

</details>

### 配置角色画面和表情包

在角色卡中编辑人设, 再选择需要的舞台方式:

- 立绘: 导入图片并选择主要资源, 按需要填写 expression 情绪分组, 让对应情绪使用这些图片.
- Live2D: 导入模型 ZIP 或目录, 选择主要模型, 再配置模型已有的表情和动作映射.
- 空白舞台: 可以只使用文字对话.

角色只能使用资源里已经配置的表现名称. 有图片不代表已经完成情绪分组, 导入模型也不代表已选择为主要模型. 表情切换用于营造场景, 不替代人设正文.

表情包与舞台立绘分别管理. 可以批量导入表情包, 导入后补充描述; 没有描述的条目不会进入角色 Prompt. 配置总览可以检查哪些图片已经就绪.

旧回复的表情包图片被删除后, 对应历史地址可能无法加载. 缺图占位不表示那张原图仍可读取. 资源用法见[角色模块](src/characters/README-zh.md).

### 按需要增加模型绑定

| 需要的能力 | 配置重点 |
| --- | --- |
| 图片理解 | 使用支持图片输入的聊天模型; 不支持直接图片时, 需要可用的 Vision 绑定提供描述 |
| 语音输入 | 配置 STT 服务及绑定 |
| 语音输出 | 配置 TTS 服务及绑定, 并为角色选用主参考音频 |
| 长期 Memory 提取与整理 | 配置 Memory 所需的 LLM 绑定 |
| Narrative 剧情检索 | 配置 Narrative 的 LLM, Embedding 和 Rerank 绑定; Embedding 必须匹配固定资产的向量空间 |

不需要的能力可以先不配. Narrative 的固定剧情 Embedding 不能只按维度相同就随意替换, 具体要求见 [Narrative](src/narrative/README-zh.md).

### 开始使用语音

参考音频需要对应的真实朗读文本和语言. 参考录音的语言与要生成的正文是不同输入, 是否支持某种组合由 TTS 服务决定, 不要把期望输出的语言填成参考录音语言.

配置 TTS 并为角色选用主参考音频后, 在聊天输入处开启 TTS, 对新的 Turn 验证语音输出. 文本回复可能先完成, 音频仍继续生成和播放, Turn 不会为等播放完成而保持运行.

历史 Turn 的播放复用已保存音频; 生成或重新生成会再次调用 TTS. 停止播放不会默认取消后台生成. data 页的音频记录可以选择可用角色, 为已有正文生成该角色的声音版本, 生成后不自动播放.

节奏和播放归属见[语音设计](docs/design/speech/README-zh.md), 服务参数见 [TTS](src/tts/README-zh.md).

### 使用工具与电脑操控

需要处理文件时, 为聊天选择明确的工作目录, 再告诉 Agent 要处理什么. 工具是否可用与启用状态, 权限模式及当前执行关系有关. 权限卡会显示本次操作和可批准范围, 本会话允许不等于给所有工具同样的授权.

Windows 电脑操控由 Agent 申请启动, 用户可以批准或拒绝. 按 Esc 或提示条结束按钮只结束操控, 对话仍可继续汇报. 聊天的停止生成则取消当前 Turn, 同时收尾所属电脑操控.

自动屏幕捕获在电脑操控设置页单独开启, 不需要为了普通文字对话打开. 开启后会在满足空闲条件时提交画面, 电脑操控期间停止自动提交. 相关行为见[电脑操控设计](docs/design/computerUse/README-zh.md).

### 从源码运行

准备环境:

- Node.js >=22. 发布构建要求 [release-config.json](apps/desktop/release-config.json) 中的精确版本, 当前为 24.13.0.
- [package.json](package.json) 声明的 pnpm 9.0.0.
- Rust 及当前操作系统所需的 Tauri 构建环境, 见 [Desktop](apps/desktop/README-zh.md).
- 使用 Live2D 时, 将有合法使用授权的 Cubism Core `06.00.0001` 放在 `apps/desktop/public/cubism/live2dcubismcore.min.js`.

在仓库根目录运行:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:start
```

桌面宿主启动前端和本地 Server, 将端口与访问密钥传给窗口. 这种桌面启动方式不需要手动设置 `EMA_SHARED_SECRET`.

`pnpm dev` 只启动前端, 不是完整桌面应用入口. 修改从 `dist` 导出的包后需要重新构建. 修改 Rust 后需要重启桌面宿主, 前端热更新不会替换原生代码.

## 构建发布包

使用固定的 Node 版本, 在目标操作系统运行:

```sh
pnpm release
```

脚本构建当前后端, 准备正式依赖, 用临时数据检查启动, 再生成安装包. Windows 默认 NSIS, macOS 默认 DMG, Linux 默认 DEB. 原生依赖在对应平台准备.

产物位于 `apps/desktop/src-tauri/target/release/bundle/`, Windows 默认在 `nsis/` 下. 显式传入 `--target` 时, 会在 `target/` 下增加对应的目标平台目录.

其他选项:

```sh
pnpm release --bundles msi
pnpm release --cubism-core /absolute/path/to/live2dcubismcore.min.js
pnpm release --server-only
```

`--server-only` 准备并验证后端, 不生成安装包. 发布脚本校验提供的 Cubism Core 是否匹配允许的哈希值, 不下载这个需要授权的运行库.

完整环境要求, 资源说明和安装后检查见 [Desktop 构建与发布](apps/desktop/README-zh.md).

### 应用版本与数据库版本

发布版本使用三段数字 `MAJOR.MINOR.PATCH`, 例如 `0.1.0`, `0.1.1` 和 `0.2.0`. Patch 用于同一版本线的问题修复. Minor 用于功能增加, 项目在 1.0 之前也可能在 Minor 中调整已有行为. `0.1.11` 是有效的补丁版本, `0.1.1.1` 不是本项目的发布格式.

预发布使用 alpha 或 beta 后缀, 例如 `0.1.0-beta.2`. Git tag 和 CHANGELOG 的版本标题使用 `v` 前缀, 例如 `v0.1.0-beta.2`; package.json, Tauri 和 Cargo 中的版本字段保留不带前缀的 `0.1.0-beta.2`. 根目录 `package.json` 确定应用发布版本, Desktop package, Tauri 配置和 Cargo package 必须与它完全一致. 发布脚本在构建之前检查这四处, 不一致时列出各自的值, 不自动修改版本. 依赖使用 pnpm 和 `pnpm-lock.yaml`.

近期版本变化见 [CHANGELOG](CHANGELOG-zh.md), 更早的发布说明和安装产物见 [GitHub Releases](https://github.com/chengyuZou/EmaAgent/releases). 设计取舍和使用说明见[文档入口](docs/README-zh.md).

数据库版本是独立整数, 不是应用版本号. Profile 和 Data 分别从自己的 `001_initial.sql` 开始, 初始数据库版本均为 1. 以后修改表结构时追加下一份 SQL, 不改已经发布的迁移文件. 启动时先执行待迁移 SQL, 成功后才接受业务请求. 某一步失败会回滚这一步, 旧应用也会拒绝打开超出自己支持版本的数据库. 没有自动降级迁移.

迁移前副本与完整数据备份的区别见[备份与升级](#备份与升级).

## 本地数据

默认目录是 `~/.ema-agent`, Windows 下是 `%USERPROFILE%\.ema-agent`. 可以通过绝对路径的 `EMA_PROFILE_DIR` 为 Desktop 和 Server 选择另一个目录.

开发版与安装版默认共用数据目录. 启动另一个版本前先关闭当前版本, 或为测试设置单独的 `EMA_PROFILE_DIR`.

| 数据目录中的位置 | 内容 |
| --- | --- |
| `profile.db` | Provider, 凭据, 模型绑定, 角色, 设置, MCP 配置和技能索引 |
| `pre-migration/` | Profile 或 Data 升级前生成的数据库副本 |
| `data/data.db` | 会话, Turn, 消息, Task, Goal, 子 Agent, 工具执行, 用量和 Memory 任务 |
| `data/attachments/`, `data/audio/`, `data/web-fetch/` | 按 Session ID 分组的受管图片和粘贴文本, 生成音频和下载文件 |
| `data/tool-results/`, `data/background-processes/`, `data/scratchpad/` | 按 Session ID 分组的工具大文本, 命令输出和临时便签 |
| `memories/` | Work 和 Relationship Markdown 文件 |
| `narrative/narrative.db` | 固定剧情原文, 图数据和向量 |
| `characters/`, `skills/`, `resources/skills/` | 角色资源, 用户 Skills 和内置 Skill 副本 |
| `profile/models-dev.json` | 本地模型目录 |
| `wallpapers/`, `logs/`, `workspace/` | 壁纸, 日志和本地工作文件 |

Provider 与 MCP 凭据明文保存在 `profile.db`. 请保护好这个目录, 分享前检查内容.

普通文件附件记录原始路径. 图片和较长的粘贴文本保存为受管副本. 移动原文件后, 对应引用可能失效.

### 备份与升级

要完整备份, 先退出应用, 再把整个数据目录复制到目录之外的备份位置. 单会话的 `.ema-session.zip` 导出用于该会话的记录和可读取的受管文件, 不包含全部设置, 凭据, 角色和 Memory.

已有数据库需要迁移时, 应用先为待升级的 Profile 或 Data 数据库创建迁移前副本. 默认 Server 使用 `<profile>/pre-migration/`. 这是数据库副本, 不包含附件, 音频或角色文件, 也没有自动恢复整个应用的功能.

不要通过安装旧应用来尝试撤销迁移. 手动恢复前保留当前数据, 并按 [Storage 的恢复说明](src/storage/README-zh.md#数据迁移)处理数据库及 WAL/SHM 文件. 会话导入导出见 [Backup](src/backup/README-zh.md).

### 重置开发数据

先退出 Ema, 再运行:

```sh
pnpm dev:reset
```

**这个命令删除所选数据目录内的全部内容, 包括数据库, 会话, 自定义角色, 记忆, 凭据, logs 和 workspace 工作文件, 不创建备份.** 设置了 `EMA_PROFILE_DIR` 时清理该目录, 否则清理默认目录. 使用同一目录的安装版也会受到影响.

下次启动桌面应用时会创建新数据库并铺设内置资源, 不会恢复已删除的自定义内容.

## 模块文档

[Desktop](apps/desktop/README-zh.md) 包含 React 界面与 Tauri 宿主, [Server](apps/server/README-zh.md) 装配 `src/` 中的业务包. 可以按想了解的功能进入:

- Agent 执行: [Turn](src/turn/README-zh.md), [Context](src/context/README-zh.md), [Tools](src/tools/README-zh.md), [Builtin Tools](src/builtin-tools/README-zh.md), [Permission](src/permission/README-zh.md), [Sandbox](src/sandbox/README-zh.md).
- 模型: [Providers](src/providers/README-zh.md), [LLM](src/llm/README-zh.md), [Vision](src/vision/README-zh.md), [Embedding](src/embed/README-zh.md), [Rerank](src/rerank/README-zh.md), [TTS](src/tts/README-zh.md), [STT](src/stt/README-zh.md).
- 角色与记忆: [Characters](src/characters/README-zh.md), [Stage](src/stage/README-zh.md), [Live2D](src/live2d-react/README-zh.md), [Memory](src/memory/README-zh.md), [Narrative](src/narrative/README-zh.md).
- 会话与工作: [Session](src/session/README-zh.md), [Attachments](src/attachments/README-zh.md), [Tasks](src/tasks/README-zh.md), [Goals](src/goal/README-zh.md), [Usage](src/usage/README-zh.md), [Backup](src/backup/README-zh.md).
- 扩展与保存: [Skills](src/skills/README-zh.md), [MCP](src/mcp/README-zh.md), [Storage](src/storage/README-zh.md), [Settings](src/settings/README-zh.md), [Prompts](src/prompts/README-zh.md), [Token 估算](src/token/README-zh.md).

## 开发检查

```sh
pnpm typecheck
pnpm test:scripts
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/desktop test
```

也要运行本次修改所涉及包的测试. Desktop 的 `test:scripts` 检查发布版本的一致性, `pnpm test` 通过 Turbo 运行工作区测试. Typecheck 和模拟测试不能替代实际应用中的安装, 原生文件拖放, 终端, 角色显示和声音检查.

本地迭代可运行 `pnpm test:watch`, 监听工作区变化并重跑受影响的构建和测试. 各包构建前会清空自己的 `dist` 目录. `pnpm clean` 清理这些 `dist` 目录, 保留 Rust 构建缓存和应用数据.

构建和类型检查最多同时运行 4 个包级任务. 根测试和测试监听命令最多同时运行 2 个包级任务, 每个包的 Vitest 使用 1 个 worker.

## 许可

代码使用 [MIT License](LICENSE). 依赖和随附资源遵守各自的许可. 分发前需要确认 Cubism Core, 立绘, 模型和声音的使用权.
