# 发布文档

[English](./README.md)

这里保存给用户看的版本变化, 以及给维护者看的 Bug 修复记录. 各个包的使用方式和实现说明仍放在对应包的 README 中.

## 子目录

| 目录 | 内容 |
| --- | --- |
| [changes/](./changes/) | 每个应用版本一个 Markdown 文件, 说明用户能得到什么, 修复了什么, 以及升级前需要知道的事项. |
| [logs/](./logs/) | 按问题命名的 Bug 修复记录. 在文件中用一级标题标明修复所属的应用版本. |

当前版本见 [0.1.0-alpha.1 草稿](./changes/0.1.0-alpha.1.md). 问题记录包括 [Live2D 发布版渲染](./logs/live2dReleaseRendering.md), [发布版样式和 Markdown 媒体](./logs/releaseUiStyles.md), [原生权限和 Server 启动环境](./logs/releasePermissionsAndEnvironment.md), 以及 [Windows 退出时弹出控制台](./logs/windowsExitConsole.md).

## 如何写版本变化

文件名使用准确的应用版本, 例如 `0.1.0-alpha.1.md`, 开头写 `# 0.1.0-alpha.1`. 每个版本保留一份文件. 正式发布前标明草稿, 发布后再填写发布日期.

写用户实际能感受到的变化, 有必要时说明升级要求和已知问题. 内部重构如果不影响使用, 不需要逐项罗列. 首次发布可以介绍已有能力, 不虚构一个之前的版本进行比较.

GitHub Release 使用同一份说明. 需要解释修复原因时链接到对应 Bug 记录, 不把完整排查过程塞进版本变化.

## 如何写 Bug 修复记录

使用能说明问题的文件名, 例如 `live2dReleaseRendering.md`, 不按版本命名文件, 也不再建立版本子目录. 每个版本的记录以 `# 0.1.0-alpha.1` 这样的一级标题开始. 同一问题在后续版本再次出现时, 在原文件中增加另一个版本标题.

说明问题表现, 复现方式, 确认的原因, 修改方式和验证结果. 简单问题用几段话写清楚即可. 区分推测和已确认原因, 也区分自动检查和安装版实机检查. 代码改了不等于原问题已经消失.

只保留有用的报错片段. 不提交 API Key, 访问密钥, 用户对话, 整份运行日志或用户数据库. `docs/logs/` 保存整理后的 Bug 记录; 程序运行日志仍写入所选用户数据目录.

文字说人话, 中英文都使用英文标点. `README.md` 使用英文, 中文对应文件为 `README-zh.md`.

## 准备一个版本

根目录 [package.json](../package.json) 确定应用发布版本. Desktop package, Tauri 配置和 Cargo package 同步为相同值. `pnpm release` 在检查构建工具, 复制资源和构建之前核对这四处. 不一致时列出各自的版本, 不自动修改文件.

Alpha 使用 `0.1.0-alpha.1` 这样的预发布版本. 每次新的公开发布使用新版本. Git Tag 使用同一版本并加 `v` 前缀, 例如 `v0.1.0-alpha.1`. 只改 Release 标题不会改变安装包中的版本.

桌面发版不要求所有内部工作区包一起升版本. 数据库版本只在 SQL 结构变化时调整, 见 [Storage](../src/storage/README-zh.md). 构建和安装版检查见 [Desktop](../apps/desktop/README-zh.md#生成安装包).
