# @ema-agent/token

本地同步估算文本, 模型消息和工具定义的大致 Token 数. 两个公开函数都只返回数字, 不调用模型, 不读取文件, 不保存会话状态或缓存.

估算用于上下文预算, 自动压缩和界面的近似用量显示. 它不按模型选择分词器, 不保证固定误差范围; 调用消耗与计费使用 Provider 返回的 usage.

## 使用

```ts
import { estimateTextTokens, estimateMessagesTokens } from '@ema-agent/token';

const textTokens = estimateTextTokens('需要估算的正文');
const inputTokens = estimateMessagesTokens(messages, tools);

```

- `estimateTextTokens(text: string): number`: 只计算文本, 不加消息格式开销. Memory 的正文裁剪, Scratchpad 的内容估算和聊天流式输出显示使用它.
- `estimateMessagesTokens(messages: readonly Message[], tools?: readonly LlmTool[]): number`: 计算传入的消息及工具定义. Context 和 Compact 使用它估算请求预算. 类型直接使用 `@ema-agent/llm` 的 Message 和 LlmTool.

完整请求应传入 system 消息, 有效历史和本次可用的工具定义. 函数不会自行补充这些内容. 工具返回内容已在消息中计算, 不要再额外累加一次. 只计算工具定义时可以传入空消息数组.

附件引用应先转换成主模型实际接收的图片或描述文本. 本包不决定使用原图还是 Vision 描述, 也不判断哪些历史被摘要替代, 或哪些推理块会被目标协议移除. 调用方负责提供需要计算的内容.

## 计算规则

| 内容 | 当前估算方式 |
|---|---|
| 文本 | ASCII UTF-16 码元数除以 4, 其余码元数除以 1.5, 相加后向上取整 |
| 消息格式 | 每条消息加 10 |
| 图片 | 像素数除以 750 后向上取整, 限制在 85 到 5,334; 尺寸缺失或无效时取 5,334 |
| 音频 | 每秒 32, 向上取整且至少为 1; 时长缺失或无效时取 8,000 |
| 文档 | 页数向上取整后乘以 2,000; 页数缺失或无效时取 8,000 |
| 工具调用 | 参数 JSON 的文本估算加 20; 参数无法序列化时参数部分取 1,000 |
| 工具定义 | 名称, 描述和参数结构的 JSON 文本估算加 20; 无法序列化时整项取 1,000 |

文本算法统计的是 UTF-16 码元, 不专门识别汉字; 表情等字符也按实际码元计算. 消息格式开销和媒体默认值是近似数, 不保证一定高于真实用量.

空文本返回 0; 消息与工具数组均为空时返回 0. 推理文本, 工具返回的文本与图片都会计入消息总数, 图片等媒体不按 Base64 字符串长度估算.

## 验证入口

`tests/estimate.test.ts` 检查文本与消息格式开销, 媒体默认值和已知尺寸, 以及工具定义与工具结果是否计入总数. 这些检查验证计算规则, 不代表与任一模型的真实分词结果相同.
