# @ema-agent/vision

`src/vision` 是一次性视觉任务模块：接收已经解析好的模型连接、若干图片和任务指令，复用 `@ema-agent/llm` 的唯一协议执行链，返回中立文本、结构化块与 Provider Usage。

它不拥有 Session、Turn、历史消息、Provider 配置、模型绑定、附件文件、描述缓存、并发队列、重试或 Usage 写库。

```text
Provider / 装配层
  └─ createVisionCall(connection, modelId)
       └─ callVision({ images, task?, language?, instruction?, signal? })
            ├─ 构造视觉任务 Prompt + 中立图片块
            ├─ createLlmCall() + createLlmCompletion()
            └─ { text, markdown?, blocks, usage? }
```

## 公共入口

```ts
const callVision = createVisionCall({
  providerId: 'openai',
  protocol: 'openai-responses-llm',
  apiKey,
  baseUrl: 'https://api.openai.com/v1',
}, 'gpt-4.1-mini');

const result = await callVision({
  task: 'ocr',
  images: [{ kind: 'bytes', bytes, mimeType: 'image/png' }],
  signal,
});
```

`task` 缺省为 `auto`。Vision 要求模型返回 JSON；模型只返回普通文本时，普通文本会降级为一个 `text` block，不会因为缺少 JSON 外壳丢失可用结果。

Vision 没有自己的 Provider protocol。`vision` capability 直接使用 LLM 已实现的 `openai-llm`、`openai-responses-llm`、`anthropic-llm` 或 `gemini-llm`，因此协议请求、流收口、Usage 和取消只有一套实现。

当前聊天模型支持图片时，附件直接进入根 LLM，不调用独立 Vision。独立 Vision 只用于不支持图片的聊天模型降级描述，以及 KB/PDF 的 OCR、图注、布局与表格提取。附件描述缓存属于 `@ema-agent/attachments`，不进入本模块。

普通 HTTP 图片 URL 不能直接交给 Gemini Files 接口；调用方需要先下载为受管字节。图片数量、单图大小、归一化、EXIF 清理和并发上限属于附件接收与调用编排，不在 Vision 重复定义。
