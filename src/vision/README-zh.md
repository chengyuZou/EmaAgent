# Vision

[English](README.md)

`@ema-agent/vision` 从图片中提取文字, 描述, 文档布局或表格. 每次将当前图片和任务说明交给 [LLM](../llm/README-zh.md), 返回文本, 可选 markdown, 内容块和模型报告的 Token 用量.

## 使用

```ts
import { createVisionCall } from '@ema-agent/vision';

const callVision = createVisionCall({
  providerId: 'my-provider',
  protocol: 'openai-responses-llm',
  apiKey,
  baseUrl,
}, modelId);

const result = await callVision({
  task: 'ocr',
  images: [{ kind: 'bytes', bytes, mimeType: 'image/png' }],
  signal,
});

// result.text, result.markdown, result.blocks, result.usage
```

`VisionConnection` 使用 LLM 的连接类型. 可以选择已经实现的四种 LLM 协议, 模型需要支持图片. 同一个调用函数为后续图片任务复用一个 `CompleteLLM`.

图片可以是字节, Base64 或 URL. 字节与 Base64 输入需注明 PNG, JPEG, WebP 或 GIF MIME 类型. Base64 中的数据 URL 前缀和空白会在发送前去除. 这里拒绝 Gemini 的普通 HTTP(S) 图片 URL. 调用方应传入下载后的字节, 或使用所选服务支持的 Gemini Files/Cloud Storage URI.

## 任务和结果

| 任务 | 要求模型输出的内容 | 默认最大输出 Token |
| --- | --- | --- |
| `auto` | 优先提取可读文字, 没有可读文字时给出简短描述. | 2048 |
| `caption` | 场景, 物体, UI 状态和相关可见细节. | 1024 |
| `ocr` | 按阅读顺序提取文字, 保留有用换行. | 2048 |
| `layout` | 文字, 布局区域, 标题, 表格和插图. | 4096 |
| `table` | 尽量还原为 markdown 的表格. | 4096 |

默认任务是 `auto`. `language` 和 `instruction` 向 Prompt 添加说明. `maxOutputTokens` 覆盖任务默认值, 传入 `temperature` 时会继续交给 LLM.

每次请求只有一条用户消息, 包含提取 Prompt 和图片. 请求关闭思考, 不携带聊天历史或工具定义. `createVisionCall` 通过 `createLLMCompletion(connection, modelId)` 创建 completeLLM. 每次 `completeLLM(request)` 发送一次 SDK 非流式请求, 将完整模型结果交给 Vision 解析.

Prompt 要求 JSON, 包含 `text`, 可选 `markdown` 和 `blocks`. 内容块可以是文字, 表格, 图片, 布局, 公式或图注. 解析函数接受 JSON, 代码围栏中的 JSON, 或前后带文字的 JSON 对象. JSON 无效或只有普通文本时, 正文保留为一个文字块. 缺少块 ID 时自动生成, 未知 kind 改为 `text`, 没有文本和 markdown 的块丢弃. 没有有效块时, 从顶层文字或原始回复创建一个文字块.

`bbox` 表示 `[x, y, width, height]`. Prompt 要求归一化坐标, 但解析只检查四个数值有限. `confidence` 也只检查数值有限. 两者都是模型报告的值, 不保证是经过验证的测量值, 也不保证落在 0..1.

## 失败和取消

空模型名, 空图片列表或载荷, 无效输出上限和非有限 temperature 会抛出错误码为 `vision/invalid_request` 的 `VisionError`. 不支持的 Gemini URL 在执行 LLM 前报 `vision/unsupported_input`. 可见回复为空时报 `vision/invalid_response`.

其他 LLM 错误包装为 `vision/call_failed`, 保留原始 cause 和可取得的数字 HTTP status. 通过 `signal` 取消时直接向上抛出, 不包装为供应商失败. 是否重试由调用方决定, Vision 只执行一次请求.

## 接入和测试

Server 的 [Turn 接线](../../apps/server/src/composition/turn.ts) 在聊天模型不能接收图片时提供 Vision, 生成附件描述. 聊天模型支持图片时直接接收图片. [DescribeImage](../builtin-tools/tools/DescribeImageTool/describeImageTool.ts) 和 [PDF 读取器](../builtin-tools/tools/FileReadTool/pdfReader.ts) 用于显式图片识别和文档任务. 附件流程负责缓存图片描述.

可以从 [visionModel.ts](visionModel.ts) 看请求构造, 从 [prompts.ts](prompts.ts) 看任务指令和默认预算, 从 [parse.ts](parse.ts) 看回复解析.

```sh
pnpm --filter @ema-agent/vision test
pnpm --filter @ema-agent/vision typecheck
```

测试覆盖单次请求构造, 协议选择, 无效输入, 取消, JSON/文本解析, 任务预算和固定 Prompt. 调用方传入的语言与补充指令保持原样, 不改写其中的标点.
