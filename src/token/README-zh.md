# @ema-agent/token

[English](./README.md)

估算一段文本或一次模型请求大约包含多少 Token. 两个公开函数都同步执行, 返回一个数字. Ema 用这些估算分配上下文预算, 判断何时压缩历史, 限制返回的正文长度, 以及在回复流式输出时显示近似用量.

## 使用

```ts
import type { LlmTool, Message } from '@ema-agent/llm';
import { estimateMessagesTokens, estimateTextTokens } from '@ema-agent/token';

const messages: readonly Message[] = [
  { role: 'system', content: 'Answer briefly.' },
  { role: 'user', content: 'Hello.' },
];
const tools: readonly LlmTool[] = [{
  name: 'Read',
  description: 'Read a file at the given path.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

const textTokens = estimateTextTokens('abcd'); // 1
const inputTokens = estimateMessagesTokens(messages, tools);
const toolsTokens = estimateMessagesTokens([], tools);
```

| 函数 | 输入 | 返回值 |
| --- | --- | --- |
| `estimateTextTokens(text)` | 字符串. | 文本的估算 Token 数. |
| `estimateMessagesTokens(messages, tools?)` | `@ema-agent/llm` 的 `Message[]` 和可选的 `LlmTool[]`. 两个数组都支持只读形式. | 所有传入消息和工具定义的估算 Token 总数. |

估算完整请求时, 传入系统提示词, 当前有效历史, 新消息和可用的工具定义. 工具返回内容已经包含在消息里, 每份结果计算一次即可. 空字符串返回 `0`. 消息与工具数组都为空时返回 `0`.

## 数据如何传到估算函数

普通模型调用按以下顺序处理:

1. 调用方准备模型消息. 保存的附件路径在估算前转换成图片, 文本或其他模型内容块. 图片通过 Vision 处理时, 计入的是描述文本.
2. [`assembleContext`](../context/assembleContext.ts) 把 Prompt 块转换成 system 消息, 放在工作消息前面, 并将当前工具池转换成 `LlmTool[]`.
3. [`estimateContextUsage`](../context/contextUsage.ts) 把这些消息和工具传给 `estimateMessagesTokens`. 返回的数字成为 `estimatedInputTokens`.
4. [`prepareAgentIteration`](../turn/prepare/prepareAgentIteration.ts) 把估算值交给 Compact 检查请求预算. Compact 用同一个函数估算候选历史和摘要请求. 装配得到的上下文用量也用于桌面的上下文球. Provider 回报某次调用的用量后, Context 可以使用该次调用的实报输入数.

返回的数字对应传入的输入内容. 调用方将它与所选模型的上下文窗口比较, 并单独计算可用的输出预算. 估算发生在各 Provider 的请求格式转换之前, 因此可能与 Provider 的计数不同.

其他调用方也使用这两个函数:

- [手动压缩](../commands/compact/compactSession.ts) 先估算历史, 判断是否接受 `/compact`, 再将系统消息计入压缩请求的估算.
- [Memory 摘要](../memory/common/memorySummary.ts)和 [Memory 文件读取](../memory/common/memoryFiles.ts)根据文本估算, 将正文裁剪到各自的预算内.
- [Scratchpad 工具](../builtin-tools/tools/ScratchpadTool/ScratchpadTools.ts)随条目内容返回估算 Token 数.
- 桌面的[回复页脚](../../apps/desktop/src/chat/messages/TurnFooter.tsx)在尚无输出用量时, 估算可见的回复文本.

## 计算规则

文本按 UTF-16 码元计算, 也就是 JavaScript 字符串下标使用的单位. 每段文本的估算为 `ceil(ASCII 码元数 / 4 + 其他码元数 / 1.5)`. 例如, `abcd` 得到 `1`, `abcd你好` 得到 `3`, `😀` 占两个码元, 得到 `2`.

| 内容 | 计算方式 |
| --- | --- |
| 消息格式 | 每条消息加 `10`, 内容为空的消息也计入. |
| 文本和可读的推理文本 | 每段字符串或内容块分别按文本规则计算, 再相加. `reasoning` 在有 `summaryText` 时计入该文本. |
| 图片, 包括工具结果中的图片 | 宽高均为正有限数时, 使用 `ceil(width * height / 750)`, 限制在 `85` 到 `5,334`. 否则使用 `5,334`. |
| 音频 | `durationMs` 为正有限数时, 使用 `ceil(durationMs / 1,000 * 32)`, 至少为 `1`. 否则使用 `8,000`. |
| 文档 | `pageCount` 为正有限数时, 使用 `ceil(pageCount) * 2,000`. 否则使用 `8,000`. |
| 工具调用 | 将参数序列化成 JSON, 对所得文本估算后加 `20`. 序列化抛错时, 参数部分取 `1,000`, 总计 `1,020`. |
| 工具定义 | 将 `name`, `description` 和来自 `inputSchema` 的 `parameters` 序列化成 JSON, 对所得文本估算后加 `20`. 序列化抛错时, 整项取 `1,000`. |
| 工具结果 | 计算其中的文本, 或逐项计算其中的文本和图片. |

每段文本或内容块分别取整. 同一段文本拆成更多内容块后, 总数可能变化. 媒体按尺寸, 时长或页数估算, 使用 URL 或 Base64 保存内容不会按这些字符串的长度计算.

这些规则是各模型共用的本地近似算法. 消息格式预留值和媒体默认值可能低于或高于实际用量. 消耗统计与计费使用 Provider 返回的 usage.

## 如何检查代码

在仓库根目录执行:

```sh
pnpm --filter @ema-agent/token test
pnpm --filter @ema-agent/token typecheck
```
