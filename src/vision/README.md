# Vision

`src/vision` 是 Ema 的图像理解执行面：接收已经解析好的协议连接与图片，调用一次远端视觉协议，返回中立文本、结构化块和 Provider Usage。

它不拥有 Provider 配置、模型选择、文件读取、图片缩放与体积策略、并发队列、超时器、热刷新、重试、Probe、Usage 写库、Session 或 Turn。

```text
Provider / 接线层
  └─ createVisionModel({ protocol, apiKey?, baseUrl? })
       └─ analyze({ model, images, task?, language?, instruction?, signal? })
            └─ { text, markdown?, blocks, usage? }
```

## 公共接口

```ts
const vision = createVisionModel({
  protocol: 'openai-vision',
  apiKey,
  baseUrl: 'https://api.openai.com/v1',
});

const result = await vision.analyze({
  model: 'gpt-4o-mini',
  task: 'ocr',
  images: [{ kind: 'bytes', bytes, mimeType: 'image/png' }],
  signal,
});
```

`task` 缺省为 `auto`。Vision 会要求模型返回 JSON；若模型只返回普通文本，普通文本会降级为一个 `text` block，不因为缺少 JSON 外壳丢失可用 OCR 结果。

三种协议映射留在包内：

- `openai-vision`：OpenAI Chat Completions 图像内容；
- `anthropic-vision`：Anthropic Messages 图像块；
- `gemini-vision`：Gemini `inlineData` / Files URI。

Gemini 不能直接读取普通 HTTP 图片 URL，因此该输入会明确失败；调用方需要先通过受控公网请求下载并转为 `bytes`。协议请求只执行一次，SDK 内建重试关闭。调用方通过 `signal` 组合取消与超时，并在真实业务边界记录 Usage、执行 Probe 或安排重试。

图片数量、单图大小、总字节、归一化、EXIF 清理与并发上限属于附件接收和视觉调用编排。把这些限制再放入 Vision 请求会形成第二套可能漂移的产品策略，因此不在本包定义。
