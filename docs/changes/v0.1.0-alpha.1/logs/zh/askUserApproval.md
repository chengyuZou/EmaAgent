# AskUser 提问前的额外审批

[English](../en/askUserApproval.md)

## 状态与范围

2026-10-20 确认原因. 用户原先报告实际问题选项出现前, 先出现显示 AskUser 原始参数的权限卡片. 源码复现不需要 UI, 模型调用或任何已保存的权限规则. 诊断期间没有修改业务代码或真实用户数据. 用户随后将 AskUser 自身权限检查改为返回 `allow`, 源码核对未重新运行测试. 同日用户确认 AskUser 已不再先走 Permission 询问, 本项额外审批问题按该用户测试版本验收通过. 准确构建标识和 Dev/发布版类型未说明, 不代表所有 AskUser 交互或全部发布包已验收.

自定义答案输入框外观是另一条反馈, 可读截图显示圆角文本输入框外沿出现额外直角矩形, 与外层已选选项卡的边框不同. 该视觉问题不属于这项审批修复, 审批调整没有修改输入框或权限菜单样式.

## 源码调整前的复现

本地 stdin 测试通过 `node --experimental-transform-types --input-type=module -` 运行, 使用真实的 [AskUserTool](../../../../../src/builtin-tools/tools/AskUserTool/AskUserTool.ts), [ToolPool](../../../../../src/tools/assembly/toolPool.ts) 和 [ToolCallExecution](../../../../../src/tools/execution/toolCallExecution.ts), 权限规则桶为空且使用默认模式. 测试输入包含一个问题和两个选项, 两种交互回调都由内存响应立即完成, 并记录回调顺序.

断言要求只进入问题回调. 连续两次运行均在不到一秒内失败:

```text
expected calls: ["question"]
actual calls:   ["permission", "question"]
AssertionError: AskUser must reach the question channel without an extra approval.
exit code: 1
```

对照测试将 `@ema-agent/tools` 和 `@ema-agent/permission` 导入指向当前源码入口, 将相对 `.js` 源码导入解析为 `.ts`, 再执行真实调用路径, 排除旧包构建造成的干扰. 导入重定向仅存在于该 Node 进程中, 没有修改文件或运行配置.

## 对照

待区分的原因包括 AskUser 专属权限判断, 中央默认模式规则, 以及前端混淆提问和审批事件. 每个对照只改变所述比较条件中的一个输入:

| 条件 | 回调顺序 / 结果 |
| --- | --- |
| 真实 AskUser, 默认模式, 无规则 | 先审批, 再提问 |
| 只将模式改为 `bypassPermissions` | 先审批, 再提问 |
| 只添加用户级整工具 allow 规则 | 先审批, 再提问 |
| 只将测试副本的 `checkPermissions` 改为返回 `allow` | 仅提问 |
| 只将测试副本的 `requiresUserInteraction` 改为 false | 先审批, 再提问 |
| 自检 allow, 添加显式整工具 deny 规则 | 不触发交互回调, 返回 `permission/denied` |
| 自检 allow, 添加显式整工具 ask 规则 | 先审批, 再提问 |

7 项对照断言全部通过. 测试副本是保留真实工具 schema, 校验和执行逻辑的内存对象, 仅替换表中指定字段. 这不是已发布修复, 也不是完整交互回归.

## 确认的原因与事件流

诊断时 AskUser 的 `checkPermissions` 固定返回 `behavior: 'ask'`. 附近注释将等待用户回答与要求批准工具执行混为一谈.

[hasPermissionsToUseTool](../../../../../src/permission/hasPermissionsToUseTool.ts) 在 bypass 模式和普通用户/项目 allow 规则之前处理工具的显式 ask. 因此 [ToolCallExecution](../../../../../src/tools/execution/toolCallExecution.ts) 会先调用 `askPermission`, 再进入 `execute`, 由 AskUser 调用独立的 `askUser` 通道. 精确输入的 Session 授权属于更早的另一条规则路径, 所以工具返回 ask 并不等于绝对禁止所有基于规则的放行.

[prepareTurnTools](../../../../../src/turn/tools/turnTools.ts) 为前一个通道发布 `permission_required`, 为后一个通道发布 `ask_user_required`. 前端 [session activity Store](../../../../../apps/desktop/src/stores/sessionActivity.ts) 将两者保留为不同交互类型, [PendingInteractionView](../../../../../apps/desktop/src/chat/interactions/PendingInteractionView.tsx) 选择对应视图. 用户报告的默认顺序在渲染前就已产生, 不是前端把问题卡片换了权限标签.

`requiresUserInteraction` 由流式执行器的等待用户检查读取. 它不是请求权限的开关, 不应为解决此现象而删除.

## 源码调整与剩余验证

用户将 AskUser 自身权限检查改为返回 `allow`. 源码核对确认了这项局部调整; 实际提问通道, 等待用户标记, 取消, 答案映射和中央显式 ask/deny 规则仍保留. 目的是在普通情况下去掉额外审批, 不改变其他工具, 也不忽略显式用户策略. 本次调整不包含让 AskUser 豁免显式策略.

按用户要求, 源码核对没有运行测试. 此前内存对象的 allow 对照支持诊断结论, 但不代表修改后文件已通过回归. 后续用户确认说明测试应用中问题展示前已不再出现多余审批. 该确认未覆盖显式规则行为, 回答/取消及多个提问调用, 这些行为仍需验证. 原生前后台通知选择和自定义答案输入框样式继续作为独立工作.
