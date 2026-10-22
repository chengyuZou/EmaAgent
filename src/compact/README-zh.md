# Compact

[English](./README.md)

Compact 缩短模型可见历史, 让 Session 能在模型窗口内继续. `createCompact(completeLLM, overrides?)` 返回接收 `CompactRequest` 的函数. Turn 在模型调用前使用它, Commands 用它执行手动压缩.

## 输入与返回

传入不含 system 消息的工作 `messages`, 独立的 `systemMessages` 和 `tools`, 模型窗口与可选输出上限, 以及完整请求的 `estimatedInputTokens`. 替换历史时, System Prompt 和工具定义仍占用预算.

- `unchanged`: 原工作消息, Macro 失败时可附带原因.
- `micro`: 将较早的可压缩工具结果替换为短占位文本后的消息.
- `macro`: 用 `<context-summary>` 包裹的 user 摘要消息, 后接近期原文. 附带压缩前后估算, 减少量, 耗时和 `summarizedMessageCount`.

`summarizedMessageCount` 是从输入开头算起被摘要覆盖的消息数, 已有摘要也算一条. 它不是 SQL ID. 可选的同步回调 `saveMacroSummary(summary, summarizedMessageCount, savedTokens)` 由调用方把数量映射到存储历史的位置.

## 处理过程

1. 用完整输入检查 `floor(contextWindow * (1 - bufferRatio))` 预算和连续失败限制.
2. 未禁用时执行 Micro, 替换 `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` 较早的成功结果, 保留设置指定的最近条数. 已满足预算时返回 Micro.
3. 否则执行 Macro, 选择近期原文, 按时间顺序分段总结此前全部消息. 分段与保留边界不会拆开工具调用和对应结果.
4. 每次模型请求带上前一段摘要, 接下来一段原文和摘要指令. 输入过长或输出截断时缩短当前段重试, 每段最多尝试三次. 得到可用摘要后才推进消息位置.
5. 检查完整摘要加近期原文是否符合预算, 执行可选保存回调, 再发送 `compact_completed` 并返回 Macro.

Micro 不调用模型, 也不修改存储历史. Macro 任一段失败都返回原输入, 不返回半成品摘要或 Micro 替换结果. 配置用量记录器时, 每次模型请求单独记账. 保存抛错会发送 `compact_failed` 并继续抛出. 取消会发送 `compact_cancelled` 并抛出取消错误. SQL 保存与运行登记由调用方管理.

摘要指令要求保留已保存的 TurnReminder 角色切换区段, 包括摘要前缀结束时的发言者, 使原切换提醒被替换后, 保留原文仍能区分归属. 切换记录是历史事实, 不是覆盖当前 System 人设的指令. 用户事实和工具结果与角色身份分开记录.

## 设置

| `context.compact` 下的设置 | 默认值 | 含义 |
| --- | --- | --- |
| `bufferRatio` | `0.15` | 模型窗口中预留在输入预算以外的比例. |
| `keepRecentToolResults` | `6` | Micro 保留的近期可压缩结果条数. |
| `maximumConsecutiveFailures` | `3` | 同一个压缩函数内, Session 连续失败达到此次数后暂停自动尝试. |
| `retainRatio` | `0.16` | 近期原文初始预算占模型窗口的比例, 放不下时会扩大摘要范围. |
| `manualMinRatio` | `0.15` | Commands 检查的手动压缩纯历史下限. |

`force` 跳过触发阈值和失败限制, 并要求执行 Macro, 不接受仅完成 Micro. 创建函数时可以覆盖默认设置, 请求也可以传入自己的设置.

先看 [compactMessages.ts](./compactMessages.ts) 的判断, 事件和保存顺序. [macroCompact.ts](./macroCompact.ts) 包含分段预算和工具配对边界, [compactPrompt.ts](./compactPrompt.ts) 包含摘要指令. [Turn 集成测试](../turn/tests/prepareAgentIteration.test.ts) 会调用实际 Compact 入口. 本包目前没有本地测试文件.
