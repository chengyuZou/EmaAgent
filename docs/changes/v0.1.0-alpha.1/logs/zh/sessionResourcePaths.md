# Session 资源路径与备份

[English](../en/sessionResourcePaths.md)

## 行为

当前数据目录先按资源类型, 再按 Session ID 保存文件. 受管附件使用 `attachments/<sessionId>/`, 生成音频使用 `audio/<sessionId>/<turnId>/`, 下载使用 `web-fetch/<sessionId>/`, 工具大文本使用 `tool-results/<sessionId>/`, 进程日志使用 `background-processes/<sessionId>/<processId>/`, 临时便签使用 `scratchpad/<sessionId>/<turnId>/`.

Storage 通过 `@ema-agent/storage/dataPaths` 提供纯路径计算. Server 决定数据目录并负责 Session/Turn 清理. 子代理共享所属 Session 的资源, 身份与历史仍保存在 SQLite. WebFetch 下载缓存按 Session 目录隔离, Web 专用请求和目录字段不进入通用 Tool Context.

会话备份包含仍存在的下载与工具大文本, 以及附件, 音频, 进程日志和相关数据库记录. 不包含临时便签和未完成下载. 导入恢复明确的文件引用, 保留大文本修改时间, 失败或取消时只撤回本次已发布目录. 备份暂存仍使用 `.backup-temp`, 最终 ZIP 保存到用户选择的位置.

## 数据处理

该布局不在原地迁移既有运行目录, 不修改数据库结构. 重置当前数据目录前, 应退出 Ema 及其 Server 并备份现有数据. 以前的 Session ZIP 不包含下载及工具大文本, 需要保留这些文件时还应单独保存完整旧数据目录. 导入将既有会话归档中支持的内容恢复到当前布局. 普通外部文件引用保持原样.

## 验证

测试使用临时目录, 模拟网页响应, 临时或内存 SQLite. 覆盖资源位置, 两个 Session 下载隔离, 主 Agent 与子代理复用, 附件和音频读取, 大文本过期, 进程日志, Session/Turn 清理, ZIP 往返, 引用恢复, 冲突, 取消, 部分目录发布与数据库失败回滚.

这些检查不能代替桌面和安装版验收. 真实数据的备份与重置需要单独执行, 不属于自动测试. 原生窗口行为, fork 资源继承和 ToolResultGroup 渲染不变.
