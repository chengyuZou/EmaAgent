# LLM

[English](README.md)

`@ema-agent/llm` 通过 OpenAI, Anthropic 或 Gemini SDK 发送模型请求. 输入是共用的消息和工具定义, 输出可以是流事件, 也可以是包含内容块, 结束原因和 Token 用量的完整结果.

完整结果接口选择流式传输的原因见 [Complete 设计](../../docs/design/llmCompletion/README-zh.md).

## 使用

先为选定的连接和模型创建调用函数, 再决定每次请求如何接收结果.

```ts
import {
  createLLMCall,
  createLLMCompletion,
  type LLMConnection,
  type LLMRequest,
} from '@ema-agent/llm';

const connection: LLMConnection = {
  providerId: 'my-provider',
  protocol: 'openai-responses-llm',
  apiKey,
  baseUrl,
};
const completeLLM = createLLMCompletion(connection, modelId);

const request: LLMRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  signal,
};

const completion = await completeLLM(request);
// completion.blocks, completion.stopReason, completion.usage
```

需要逐步显示输出时, 用下面的方式代替 `createLLMCompletion`:

```ts
const callLLM = createLLMCall(connection, modelId);

for await (const event of callLLM(request)) {
  // 处理正文, 思考, 工具调用, 用量和 done 事件.
}
```

两个工厂都接收连接和模型 ID, 返回只接收 `LLMRequest` 的函数. `CallLLM` 返回事件, `CompleteLLM` 返回 `Promise<LLMCompletion>`. 每次执行各发出一个模型请求, 两种都执行就会发出两次请求.

最终结果函数在内部创建并收集流式请求. 调用方只提供连接, 模型和请求, 不传 CallLLM. 每次请求独占流和内容块, 工厂复用 SDK Client. 成功返回 LLMCompletion; 取消或失败关闭流并拒绝请求.

两个工厂都在创建时复制连接值, 之后修改原对象不会改变调用目标. 首次请求时才初始化协议和 SDK; `CallLLM` 则在首次消费流时初始化. 同一个函数的并发和后续请求共用这次初始化和客户端, 分别创建的函数拥有各自的客户端.

当前 SDK 依赖要求 Node >=22, 版本见 [package.json](package.json). 桌面发布使用 [release-config.json](../../apps/desktop/release-config.json) 指定的 Node 版本.

## 请求怎么传递

```text
选定的连接 + modelId
    -> createLLMCall -> callLLM(request)
        -> 一次流式 SDK 请求 -> Agent 逐个处理事件
    或
    -> createLLMCompletion -> completeLLM(request)
        -> 一次流式 SDK 请求 -> 收集有序内容块 -> LLMCompletion
```

[types.ts](types.ts) 定义连接, 请求, 结果和事件. [message.ts](message.ts) 定义消息: 系统文本, 用户文本/媒体/工具回复, 以及助手内容块. 工具定义使用 `LLMTool.inputSchema`, 工具回复放在用户消息的 `tool_result` 中, 通过 `toolCallId` 与调用配对.

协议使用 [providers](../providers/README-zh.md) 的 `LLMProtocol` 选择:

| 协议 | API | 工具回复中的图片 |
| --- | --- | --- |
| `openai-llm` | Chat Completions | 每张图片替换成明确的文字占位, 说明本次没有读取图片, 并提示在可用时调用 DescribeImage. |
| `openai-responses-llm` | Responses | 使用 `function_call_output.output` 的原生文本/图片内容, 保留 `call_id`. |
| `anthropic-llm` | Messages | 放入 `tool_result.content` 的图片内容. |
| `gemini-llm` | generateContent | `functionResponse` 放文本/JSON, 整批工具回复之后追加注明来源的图片. |

这些转换只生成 SDK 输入, 不修改保存的消息. Chat 不会为了绕过工具消息格式而追加用户图片消息. Gemini 不会把图片 Base64 放进普通 JSON.

[protocolInput.ts](protocolInput.ts) 在执行 SDK 前检查当前实现能否表达输入. Chat 实现拒绝文件块, 音频只接受 WAV/MP3. Responses 和 Anthropic 拒绝音频块. Anthropic 的内嵌图片必须是 JPEG, PNG, GIF 或 WebP. 这些检查表示已实现的转换范围, 具体模型和网关仍可能有其他限制.

切换模型后, 助手正文和工具调用仍会保留. 只有 `generatedBy.providerId`, `modelId` 和 `protocol` 与当前目标一致时, 才回传原生思考状态, 包括 Anthropic 签名, Responses reasoning item 和 Gemini thought signature. `cacheBreakpoint` 转换成 Anthropic 缓存标记, 其他协议忽略它.

`thinking.enabled: 'auto'` 保留供应商默认的思考开关. Anthropic 和 Gemini 在各自协议文件中将强度换算为 Token 预算, 不代表不同供应商的思考能力等效. 开启 Anthropic 思考时, 输出预算还必须容纳其最低思考预算.

公共请求只保留 `thinking.enabled` 和 `thinking.effort`. Chat Completions 先生成原有的 `thinking` / `reasoning_effort`, 再由 `protocols/openAiChat.ts` 内部私有函数转换已经确认的供应商差异. 官方 `api.siliconflow.cn` 和 `api.siliconflow.com` 地址接收从 `thinking.type` 拆出的 `enable_thinking`, 不同时发送 `thinking`. 这个 HTTP 字段不是公共请求或配置选项. SiliconFlow 只对该函数列出的模型 ID 发送 `high` 或 `max` 强度, 不为其他模型猜测 Token 预算. 其他地址保留原有 Chat 映射. 自定义 Provider ID 使用 SiliconFlow 官方地址时同样生效, 任意网关不按显示名猜测供应商. 依据见 [SiliconFlow 请求字段](https://docs.siliconflow.cn/docs/api/chat-completions-post)和 [DeepSeek 思考字段](https://api-docs.deepseek.com/guides/thinking_mode/).

`maxOutputTokens` 是调用方指定的本次请求预算, 不是直接使用模型完整输出容量. 完整结果接口也使用流式传输, 支持较大的输出预算. Narrative 仍由宿主指定固定的 8192 输出预算.

## 事件, 用量和失败

内容事件携带 `blockIndex`, 调用方据此拼接增量并保留正文, 思考和工具调用的最终顺序. `tool_use_complete` 给出解析后的参数. 协议成功流以明确的 `done` 结束, 没有结束事件就断流会抛出 `LLMStreamProtocolError`.

`CompleteLLM` 将响应中的正文, 思考状态和工具调用转换成有序内容块. 返回值是完整 `LLMCompletion`, 不只是可见正文. Responses 保留 output 项顺序, Anthropic 保留 content 顺序, Gemini 保留 part 顺序. Chat 将分别返回的思考, 正文和工具字段按这个顺序放入结果.

用量事件是同一次请求的累计数字. `updateLLMCallUsage` 返回当前已知最大值和相对上次报告的增量. 直接累加原始事件会重复计数. 缓存读取和写入数字已经包含在 `inputTokens` 中.

空模型名在创建工厂时失败. 不支持的消息在 `callLLM(request)` 中同步失败, 在 `completeLLM(request)` 中拒绝 Promise. SDK 初始化和网络错误按所选返回方式向上抛出. 工具参数不是合法 JSON 时抛出 `LLMToolArgumentsParseError`. 上下文过长的错误统一为 `ContextWindowExceededError`, 让调用方决定是否压缩后重试.

两个入口均要求明确的流终态. 输出上限映射为 max_tokens, 内容过滤映射为 stop_sequence. 供应商失败和意外断流拒绝请求, 不轮询或补发.

通过 `request.signal` 取消. 开始执行时已经取消的请求不初始化 SDK. 共享初始化期间取消时, 初始化结束后停止这个请求, 不取消其他请求共用的初始化. 取消和失败不会生成成功的 `done`, 也不会返回完成结果.

OpenAI 和 Anthropic 客户端关闭内建重试, Gemini 不传重试选项. 本包不自动重复失败请求. 流式 Chat 等待下一个数据块最多 60 秒, 收到结束原因后最多再等 2 秒接收尾部用量, 避免网关不关流时一直等待.

HTTP 413 若未明确表示 Token 上下文超限, 则通过 `LLMRequestTooLargeError` 上报为 `provider/request_too_large`, 显示请求体过大. 不将它当作普通服务错误或自动压缩重试的指令.

## 阅读和验证

两个工厂和延迟初始化在 [languageModel.ts](languageModel.ts), [protocols/](protocols/) 负责请求转换和流事件, [collectLLMCompletion.ts](collectLLMCompletion.ts) 收集完整结果. [usage.ts](usage.ts) 与 [errors.ts](errors.ts) 保存共用的计数和错误处理规则.

真实调用方包括 [Agent](../agent/agentLoop.ts), [Compact](../compact/macroCompact.ts), [Vision](../vision/visionModel.ts), 以及 Server 的 [Memory](../../apps/server/src/composition/memory.ts) 和 [Narrative](../../apps/server/src/composition/narrative.ts) 接线.

```sh
pnpm --filter @ema-agent/llm test
pnpm --filter @ema-agent/llm typecheck
```

[tests/languageModel.test.ts](tests/languageModel.test.ts) 检查初始化, 客户端复用, 请求参数, 失败和取消. 协议测试检查消息转换, 流事件和 [完整结果收集](tests/completionProtocols.test.ts). [tests/sdkRequests.test.ts](tests/sdkRequests.test.ts) 使用已安装的 SDK 请求本地 HTTP/SSE 服务, 检查两个入口的流式地址, 单次请求, 限流失败不重试及取消. 这些测试不调用付费模型服务.
