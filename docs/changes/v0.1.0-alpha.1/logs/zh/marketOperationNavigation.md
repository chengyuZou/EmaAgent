# 设置切页后的市场操作状态

[English](../en/marketOperationNavigation.md)

## 状态

源码修复和自动化回归通过. 2026-10-20, 用户确认 Skills 和 MCP 市场修改在 Tauri 开发版中实测通过. 安装版验收留待其余已报告问题处理完后统一执行. 本次修复没有构建或测试安装包.

## 问题与复现

开始安装 Skill 或添加 MCP 市场条目后, 按钮会显示进行中. 操作完成前离开设置页再返回, 这个提示会消失, 但已经提交的操作仍在继续. 多个目标可以同时处于进行中状态.

测试挂载真实市场页面, Store 和共享 UI, API 使用内存响应. 在安装请求仍未完成时卸载页面, 再重新挂载. 修复前两个市场测试套件中有 5 项失败, 7 项通过. 失败项检查进行中状态丢失, 重复提交, 以及安装完成后当前 Skill 页面没有更新.

## 原因

设置面板会卸载之前的子页. 每个市场页面各自持有进行中的 Set, 因此新页面从空 Set 开始.

Skill 市场还通过旧页面的完成回调刷新列表. 现有 Skill Store 在收到 `skills_changed` 时会刷新已安装目录, 但新市场页面没有刷新自己的市场列表或详情. MCP 添加完成后本来就会刷新共享的服务列表, 因此即使进行中状态消失, 最终结果仍可能出现.

后端 Skill 安装已经拒绝相同来源和 slug 的并发请求. 前端测试出现重复 API 调用, 不代表后端实际安装了两次同一个 Skill.

## 修改

- [Skill Store](../../../../../apps/desktop/src/stores/skill.ts) 持有 `installingMarketIds` 和 `installFromMarket`, 使用 `source:slug` 作为键. 它负责提交请求, 提示成功或失败, 并在操作结束时只移除该操作的键.
- [SkillMarketPage](../../../../../apps/desktop/src/settings/skills/SkillMarketPage.tsx) 读取共享 Set. 当前列表和详情订阅已有的 `skills_changed` 事件. 旧查询不能覆盖新结果或重新打开已关闭的详情. 卸载仍使用原有 API 和页面内操作状态, 结果也通过同一事件刷新.
- [MCP Store](../../../../../apps/desktop/src/stores/mcp.ts) 持有 `addingMarketEntryIds` 和 `addFromMarket`, 使用当前 Official 市场的 `externalId` 作为键. 添加配置后刷新共享服务列表. 连接信息仍以后端 `connectionStatus` 为准; 配置添加成功不等于连接成功.
- MCP 并发测试还复现了旧服务列表响应覆盖新列表, 隐藏另一个已完成添加结果的问题. 现在只有最新列表请求能更新共享状态. 每次刷新返回自己的错误或 null, 避免另一个请求的错误决定当前添加操作的提示.

搜索, 筛选, 分页, 详情选择和确认弹窗仍属于页面状态. 离开页面不会取消已经提交的安装. 安装成功后列表或详情读取失败, 会与安装失败分别提示. 本次修改没有增加重启恢复, 数据库持久化或通用任务 Store.

## 验证

| 测试 | 通过数量 | 范围 |
| --- | ---: | --- |
| [skillMarketOperations.test.tsx](../../../../../apps/desktop/tests/skillMarketOperations.test.tsx) | 14 | 单个和并发安装, 切页, 离开期间完成, 重试, 按来源去重, 当前详情刷新, 旧响应, 读取错误和卸载后刷新 |
| [mcpMarketOperations.test.tsx](../../../../../apps/desktop/tests/mcpMarketOperations.test.tsx) | 8 | 单个和并发添加, 切页, 市场查询, 后台完成, 去重, 连接状态来源, 刷新失败和列表响应乱序 |
| [speechGenerationNavigation.test.tsx](../../../../../apps/desktop/tests/speechGenerationNavigation.test.tsx) | 4 | 现有 Chat 和 data 的 TTS 重新生成路径, 未修改 TTS 业务 |
| [settingsInteractions.test.tsx](../../../../../apps/desktop/tests/settingsInteractions.test.tsx) | 7 | 现有设置交互 |

```text
pnpm --filter @ema-agent/desktop exec vitest run tests/skillMarketOperations.test.tsx tests/mcpMarketOperations.test.tsx tests/speechGenerationNavigation.test.tsx tests/settingsInteractions.test.tsx --maxWorkers=1 --minWorkers=1
Test Files 4 passed (4)
Tests 33 passed (33)
```

Desktop 类型检查通过. 另外使用 desktop 配置将两个市场测试文件纳入 TypeScript 检查, 结果也通过. 自动化测试没有执行真实下载, 安装, 付费调用或用户数据库读取.

用户随后进行的 Dev 验收与这些模拟 API 测试分别记录. Chat 和 data 的 TTS 重新生成此前已经通过用户安装版实测, 不在本次修复范围内. 切换 Session 时的 STT 录音属于另一个问题.
