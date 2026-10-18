# EmaAgent

[English](README.md)

**可以陪你聊天的桌面角色, 也是能够实际干活的 Agent.**

EmaAgent 把通用角色扮演与文件编辑, 命令执行, 网页搜索和多步骤任务放在同一个桌面应用里. 为角色配置人设, 立绘或 Live2D 模型及声音, 然后用它聊天, 查资料, 处理本机项目里的工作.

这是面向单人使用的本地优先应用, 使用 Tauri, React 和本地 Node.js Server. 对话, 设置, 角色资源和记忆保存在自己的机器上, 模型服务由你选择和配置.

## 当前能力

### 角色与对话

- 配置角色人设, 立绘, Live2D 模型和参考音频.
- 配合对应模型使用文字聊天, 图片理解, 语音输入和语音输出.
- 管理不同的会话与项目, 查看流式回复和工具结果.
- 通过文件式 Work 和 Relationship Memory 跨会话保留工作记录及关系记忆.

角色扮演不限定于内置角色或某个作品. 需要相关设定时, 独立的 Narrative 检索可以查询魔法少女的魔女审判三个周目的剧情原文.

### 实际处理工作

- 读取, 搜索, 创建和编辑文件, 执行命令并查看输出.
- 通过启用的工具搜索网页和读取页面.
- 使用 Task, Goal 和子 Agent 处理需要多个步骤的工作.
- 选择工具权限模式, 压缩较长的对话上下文, 查看模型用量记录.
- 在对话旁打开文件, Git 变更, 浏览器标签和手动终端.

文件和命令会影响你的机器. 请检查工具请求, 为任务选择合适的工作目录. 权限和命令隔离的具体行为取决于工具, 设置及操作系统, 不代表每个操作都没有风险.

### 接入模型和工具

- 分别配置 LLM, Vision, Embedding, Rerank, TTS 和 STT 的 Provider 与模型.
- 加载本地或项目 Skills, 也可以从 SkillHub 和 ClawHub 安装.
- 连接 MCP Server 来增加工具.
- 以 `.ema-session.zip` 导出和导入单个会话, 包括可读取的受管文件.

功能取决于启用的模型, 工具和本地资源. 本地优先不等于离线: Prompt, 图片, 工具结果或检索文字可能发送给配置的外部服务, 请求也可能产生费用.

## 开始使用

### 使用安装包

安装为当前操作系统构建的安装包, 然后启动 Ema. 安装目录中的 `server/` 是应用后端, 不是第二个应用, 需要与程序保存在一起. 安装包包含 Node 和正式依赖, 使用者不需要源码仓库或另装 Node.

1. 打开设置, 配置 Provider 的地址, 协议和凭据.
2. 添加或启用一个 LLM 模型, 在会话中选择它.
3. 选择角色并配置显示方式.
4. 按需为图片, 语音, Memory 或 Narrative 设置模型绑定.

Narrative 需要 LLM, Embedding 和 Rerank 绑定. Embedding 模型必须与固定剧情数据的向量空间一致, 修改前请看 [Narrative](src/narrative/README-zh.md).

开发版与安装版默认共用数据目录. 启动另一个版本前先关闭当前版本, 或为测试设置单独的 `EMA_PROFILE_DIR`.

### 从源码运行

准备环境:

- Node.js >=22. 发布构建要求 [release-config.json](apps/desktop/release-config.json) 中的精确版本, 当前为 24.13.0.
- [package.json](package.json) 声明的 pnpm 9.0.0.
- Rust 及当前操作系统所需的 Tauri 构建环境, 见 [Desktop](apps/desktop/README-zh.md).
- 使用 Live2D 时, 将有合法使用授权的 Cubism Core 放在 `apps/desktop/public/cubism/live2dcubismcore.min.js`.

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

Desktop package, Tauri 配置和 Cargo package 中的应用版本需要一致, 发布脚本会检查这三处.

数据库版本是独立整数, 不是应用版本号. Profile 和 Data 分别从自己的 `001_initial.sql` 开始, 初始数据库版本均为 1. 以后修改表结构时追加下一份 SQL, 不改已经发布的迁移文件. 启动时先执行待迁移 SQL, 成功后才接受业务请求. 某一步失败会回滚这一步, 旧应用也会拒绝打开超出自己支持版本的数据库. 没有自动降级迁移.

升级前先退出应用, 备份完整的数据目录. 重新安装旧应用不能撤销数据库迁移, 细节见 [Storage](src/storage/README-zh.md).

## 本地数据

默认目录是 `~/.ema-agent`, Windows 下是 `%USERPROFILE%\.ema-agent`. 可以通过绝对路径的 `EMA_PROFILE_DIR` 为 Desktop 和 Server 选择另一个目录.

| 数据目录中的位置 | 内容 |
| --- | --- |
| `profile.db` | Provider, 凭据, 模型绑定, 角色, 设置, MCP 配置和技能索引 |
| `data/data.db` | 会话, Turn, 消息, Task, Goal, 子 Agent, 工具执行, 用量和 Memory 任务 |
| `data/sessions/` | 受管图片, 粘贴文本, 音频和命令输出 |
| `memories/` | Work 和 Relationship Markdown 文件 |
| `narrative/narrative.db` | 固定剧情原文, 图数据和向量 |
| `characters/`, `skills/`, `resources/skills/` | 角色资源, 用户 Skills 和内置 Skill 副本 |
| `profile/models-dev.json` | 本地模型目录 |
| `wallpapers/`, `logs/`, `workspace/` | 壁纸, 日志和本地工作文件 |

Provider 与 MCP 凭据明文保存在 `profile.db`. 请保护好这个目录, 分享前检查内容. 导出单个会话并不等于备份全部设置, 凭据, 角色和记忆.

普通文件附件记录原始路径. 图片和较长的粘贴文本保存为受管副本. 移动原文件后, 对应引用可能失效.

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
pnpm test:first-start
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/desktop test
```

也要运行本次修改所涉及包的测试. `pnpm test:first-start` 构建 Server 及依赖, 使用临时数据启动进程并检查初始化和 HTTP 响应, 不请求模型. `pnpm test` 通过 Turbo 运行工作区测试. Typecheck 和模拟测试不能替代实际应用中的安装, 原生文件拖放, 终端, 角色显示和声音检查.

## 许可

代码使用 [MIT License](LICENSE). 依赖和随附资源遵守各自的许可. 分发前需要确认 Cubism Core, 立绘, 模型和声音的使用权.
