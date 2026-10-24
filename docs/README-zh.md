# 发布文档

[English](./README.md)

这里保存给用户看的版本变化和给维护者看的 Bug 修复记录. 各个包的使用方式和实现说明仍放在对应包的 README 中.

## 目录结构

```text
docs/
  README.md
  README-zh.md
  changes/
    v0.1.0-beta.1/
      README.md
      README-zh.md
    v0.1.0-alpha.1/
      README.md
      README-zh.md
      logs/
        en/
          askUserApproval.md
          marketOperationNavigation.md
          ...
        zh/
          askUserApproval.md
          marketOperationNavigation.md
          ...
```

[changes/](./changes/) 的第一层只放版本目录. 每个版本目录保存中英文版本说明, 按需附上排查记录. 说明实际检查的行为, 已知时记录准确测试构建, 区分通过, 失败, 未测和不适用. 相关检查通过不代表尚未解决的例外也已关闭.

## 版本

- [0.1.0-beta.1](./changes/v0.1.0-beta.1/README-zh.md): Beta 版本草稿, 简述实验后调整的 Narrative 处理方式和参数.
- [0.1.0-alpha.1](./changes/v0.1.0-alpha.1/README-zh.md): 版本说明草稿和排查记录索引.

各问题的证据, 当前状态和剩余检查写在对应日志中, 不在这里维护第二份状态表. 源码检查, Dev 验收和安装版验收是不同结果.

## 如何写版本变化

目录名使用准确的应用版本并加 `v` 前缀, 例如 `v0.1.0-alpha.1`. 英文版本说明放在 `README.md`, 中文放在 `README-zh.md`, 开头写 `# 0.1.0-alpha.1`, 两份文件互相链接. 正式发布前都标明草稿, 发布后再填写发布日期.

写用户实际能感受到的变化, 有必要时说明升级要求和已知问题. 内部重构如果不影响使用, 不需要逐项罗列. 首次发布可以介绍已有能力, 不虚构一个之前的版本进行比较.

GitHub Release 使用同一份说明. 需要解释修复原因时链接到对应 Bug 记录, 不把完整排查过程塞进版本变化. 英文 README 链接 `logs/en/`, 中文 README 链接 `logs/zh/`.

## 如何写 Bug 修复记录

记录放在对应版本的 `logs/en/` 和 `logs/zh/` 下, 两种语言使用相同的 camelCase 文件名, 例如 `live2dReleaseRendering.md`. 语言通过目录区分, 不加文件名后缀. 一级标题写问题名称, 不再重复版本号; 版本由目录确定. 添加指向 `../zh/` 或 `../en/` 中同名文件的语言切换链接.

两种语言的现象, 结论, 验证和剩余工作保持一致. 同一问题在后续版本再次出现时, 在新版本下建立记录并链接到之前的证据, 不覆盖旧版本的记录.

对外文档必须能独立阅读. 用具体行为说明验证结果, 不使用内部清单编号, 也不链接读者无法访问的已忽略本地测试记录或截图.

说明问题表现, 复现方式, 确认的原因, 修改方式和验证结果. 简单问题用几段话写清楚即可. 区分推测和已确认原因, 也区分自动检查和安装版实机检查. 代码改了不等于原问题已经消失.

只保留有用的报错片段. 不提交 API Key, 访问密钥, 用户对话, 整份运行日志或用户数据库. 各版本的 `logs/` 保存整理后的 Bug 记录; 程序运行日志仍写入所选用户数据目录.

文字说人话, 中英文都使用英文标点. `README.md` 使用英文, 中文对应文件为 `README-zh.md`.

## 准备一个版本

根目录 [package.json](../package.json) 确定应用发布版本. Desktop package, Tauri 配置和 Cargo package 同步为相同值. `pnpm release` 在检查构建工具, 复制资源和构建之前核对这四处. 不一致时列出各自的版本, 不自动修改文件.

Alpha 使用 `0.1.0-alpha.1`, Beta 使用 `0.1.0-beta.1` 这样的预发布版本. 每次新的公开发布使用新版本. Git Tag 使用同一版本并加 `v` 前缀, 例如 `v0.1.0-beta.1`. 只改 Release 标题不会改变安装包中的版本.

桌面发版不要求所有内部工作区包一起升版本. 数据库版本用于记录 SQL 结构变化及必要的已存数据迁移, 见 [Storage](../src/storage/README-zh.md). 构建和安装版检查见 [Desktop](../apps/desktop/README-zh.md#生成安装包).
