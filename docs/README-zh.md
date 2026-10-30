# 文档入口

[English](./README.md)

安装和功能演示见[项目 README](../README-zh.md), 近期变化见[CHANGELOG](../CHANGELOG-zh.md).

## 使用说明

- [根 README 的开始使用](../README-zh.md#开始使用): 文字模型配置, 角色资源, 可选能力和语音; 数据章节说明备份与升级.

## 按需要阅读

- [桌面应用](../apps/desktop/README-zh.md): 开发运行, 构建, 发布和前端职责.
- [原生桌面程序](../apps/desktop/src-tauri/README-zh.md): 窗口, 通知, 本地命令及进程生命周期.
- [角色资源](../src/characters/README-zh.md): 人设, Live2D, 插图, 参考音频和表情包.
- [电脑操控](../src/computer-use/README-zh.md): Node 与原生程序通信, 操控归属与结束.
- [Turn](../src/turn/README-zh.md)和[工具](../src/tools/README-zh.md): 对话执行与工具调度.
- [Memory](../src/memory/README-zh.md)和[Narrative](../src/narrative/README-zh.md): 长期记忆与剧情检索.
- [Storage](../src/storage/README-zh.md): 数据库, 迁移与升级前备份.

## 设计取舍

这些文档解释为什么作出选择, 考虑过什么办法, 接受什么成本和限制. 用法与实现约定由各模块 README 说明.

- [电脑操控](design/computerUse/README-zh.md): 为什么取消自动暂停, 并让操控随 Turn 结束.
- [Memory](design/memory/README-zh.md): 为什么采用可编辑文本, 以及活跃日期保留的取舍.
- [剧情检索](design/narrative/README-zh.md): 为什么采用 LightRAG, 保留提问意图并控制检索成本.
- [输入队列](design/inputQueue/README-zh.md): 为什么统一交付输入, 区分引导并在保存后确认消费.
- [语音](design/speech/README-zh.md): 为什么区分生成, 播放归属和声音版本, 以及当前 B 测的节奏选择.
- [Stage](design/stage/README-zh.md): 为什么为静态立绘配置情绪, 营造类似 Galgame 的场景感.
- [通用知识库](design/knowledgeBase/README-zh.md): 为什么先用已有文件工具, 删除 KB 并等待明确需求.
- [历史分支](design/sessionBranches/README-zh.md): 为什么因派生工作归属复杂而暂缓 Session 内分支.
- [角色切换](design/characterSwitch/README-zh.md): 为什么在 TurnReminder 标明边界, 不逐条重写旧助手消息.
- [媒体预算](design/mediaBudget/README-zh.md): 为什么所有媒体来源共用预算, 并优先省略较早内容.
- [权限判断](design/permissions/README-zh.md): 为什么集中作决定, 并明确用户批准的范围.
- [完整 LLM 结果](design/llmCompletion/README-zh.md): 为什么由内部 CallLLM 收集流, 避免原生非流式请求的实际限制.

## 文档分工

| 位置 | 内容 |
| --- | --- |
| 根 README | 用户能做什么, 如何安装运行, 实际截图 |
| 根 CHANGELOG | 未发布变化及最近最多 30 个已发布版本的简短变化 |
| 各模块 README | 当前职责, 入口, 正常流程, 重要约束 |
| docs | 使用说明, 设计理由, 接受的取舍与当前限制 |
| GitHub Issue | 可复现的问题, 环境, 日志和处理进度 |
| GitHub Release | 对应版本的发布说明及安装产物 |
| assets/screenshots | 产品演示原图及用途索引 |

设计说明可以解释为什么采用某种方案, 哪些需求没有覆盖, 以及什么证据会促使我们重新评估. 已放弃的方案只在解释当前取舍有帮助时保留, 不写成仍可用的功能. 单次排查的完整转储和实验产物不放进用户文档.

文档按现有实现编写, 验证记录区分自动检查, Dev 实机验证和安装版验证. 英文入口使用 README.md, 中文放同目录 README-zh.md. Issue 表单使用英文 / 中文字段, 不要求普通用户提供整个数据库.

历史排查和实验产物保存在仓库之外, 不作为构建或运行应用的前提. 新的问题进度放 GitHub Issue, 设计说明只保留与选择有关的理由和证据.
