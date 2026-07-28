# `@ema-agent/vision`

`@ema-agent/vision` 是 EmaAgent 产品源码中的独立视觉提取模块。

它接收图片、截图、扫描页(以及未来的视频帧),返回文本 / markdown / 结构化块(block),供对话附件、文档导入、知识库索引和 Ema 实时视觉功能使用。

## 边界

```text
attachments / document ingest / knowledge ingest / Ema visual features
  -> VisionRuntime
    -> provider id -> VisionAdapter
      -> provider vision endpoint
```

Vision 不负责文件存储、附件元数据、分块(chunking)、向量索引或知识库生命周期。它只把视觉输入转成稳定的 `VisionExtractionResult`。

Vision 也独立于 `@ema-agent/llm`。某个 Vision Provider 可能暴露 OpenAI 兼容的 Chat Completions 协议，但 Vision 模块自带 Adapter，不依赖 LLM 模块。Core wiring 将 Vision 与 LLM、TTS、STT、Embed、Rerank 同等对待：独立配置、独立运行时、独立能力表面。

## 运行时形态

生产接线在 `apps/localHost` 中创建一个 `VisionRuntime`，再把执行入口直接注入需要视觉能力的装配点：

```text
LocalHost wiring
  -> vision = new VisionRuntime({
       configs: visionProviderConfigs,
       limits,
     })

TurnInputPreparer / knowledge ingest / probe route
  -> vision.extract(...)
```

`VisionRuntime` 使用单张 Runtime Entry 表原子保存 Provider 配置与 Adapter。每次调用的图片载荷、Prompt、解析状态和 AbortController 都留在 `extract()` 局部，因此对话、附件和知识库任务不会互相覆盖。

## Provider 模型

Vision 支持三个协议, 每个协议一个 adapter, 各用官方 SDK:

| protocol | adapter | SDK |
|---|---|---|
| `openai-vision` | `OpenAiVisionAdapter` | `openai` |
| `anthropic-vision` | `AnthropicVisionAdapter` | `@anthropic-ai/sdk` |
| `gemini-vision` | `GeminiVisionAdapter` | `@google/genai` |

构造示例:

```ts
const vision = new VisionRuntime({
  configs: [{
    id: 'openai-vision-main',
    protocol: 'openai-vision',
    apiKey,
    baseUrl: 'https://api.openai.com/v1',
  }],
});
```

OpenAI 兼容的 provider(如 SiliconFlow)可以用 `openai-vision` 协议, 配自己的 baseUrl 和模型名。Anthropic / Gemini 各用原生 SDK, bytes 图片统一用 `Buffer.from(bytes).toString('base64')` 转 base64。

## 图片输入

`VisionImageInput` 是三态联合类型, adapter 各自转成 provider 要的格式:

- `bytes`: `Uint8Array` 原始字节, adapter 用 `Buffer.from(bytes).toString('base64')` 转 base64 再拼 data URL
- `base64`: 已是 base64 字符串, 直接用
- `url`: 图片 URL。OpenAI / Anthropic 直接传；Gemini 只接受 `gs://` 或 Files API URI，普通 HTTP URL 会让整次请求以 `unsupported_input` 失败，禁止静默漏图

## 任务与块类型

**任务(task)** -- 告诉 LLM 这次提取目标, 5 种:

- `auto`: 自动判断, 有文字优先 OCR, 否则给视觉描述
- `caption`: 看图说话, 描述场景 / 物体 / UI 状态
- `ocr`: 提取所有可读文字, 保留换行
- `layout`: 提取文字 + 描述布局结构(标题 / 表格 / 图 / 层级)
- `table`: 专注表格, 重建成 markdown

`task` 对调用方可选, 默认 `auto`。adapter 收到的请求里 `task` 和 `parseMode` 必填(router 填好默认值)。`defaultMaxTokensForVisionTask` 按任务给 token 上限: auto / ocr = 2048, caption = 1024, layout / table = 4096。

**块类型(VisionBlockKind)** -- LLM 返回的结构化块分类, 6 种: `text` / `table` / `image` / `layout` / `formula` / `caption`。每个 block 可带 `bbox`(归一化坐标 [x, y, w, h], 取值 0-1)和 `confidence`。`parse.ts` 校验 kind 合法性, 不合法退回 `text`。

## 并发控制(VisionLimiter)

`VisionRuntime` 使用独立的 `VisionLimiter` 做全局和单 Provider 双限流，防止撞 Provider 限流与内存峰值。它不创建进程，只维护进行中请求计数和有界等待队列。

默认上限（`DEFAULT_VISION_LIMITS`）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentGlobal` | 4 | 全局并发上限 |
| `maxConcurrentPerProvider` | 2 | 每个 provider 并发上限 |
| `maxQueuedRequests` | 64 | 等待队列上限, 满了抛 `concurrency_limited` |
| `maxImages` | 8 | 单次最多图片数 |
| `maxBytesPerImage` | 10 MB | 单图字节上限 |
| `maxTotalBytes` | 20 MB | 单次总字节上限 |
| `timeoutMs` | 60 s | 请求超时(含等槽位时间) |

**调度模型**:

- 请求来 -> `canAcquire`(全局没满 + 该 provider 没满)立即发牌; 否则进 FIFO 等待队列
- 队列满 -> 抛 `vision/concurrency_limited`(retryable, 可重试)
- 某个在跑的请求完成 -> `release()` 归还槽位 -> 触发 `drain()` 重新调度等待者
- 某 provider 饱和时不阻塞其他 provider(`drain` 遍历时跳过饱和的 waiter, 继续看下一个)
- 排队期间用户取消 -> `AbortSignal` 触发 `onAbort` -> waiter 从队列移除 + reject(立即生效, 不等调度)
- `release` 幂等(released flag), 多次调不穿计数

单次调用可传 `limits?: Partial<VisionLimits>` 收紧上限，但不能突破 Runtime 级硬上限。

## 数据流

```text
VisionRequest
  -> normalize task / parse mode(填默认 auto / best_effort)
  -> validate image count and byte budgets(图数 + 字节上限)
  -> 等并发槽位(全局 + per-provider, 有界队列, 可 abort)
  -> createVisionRequestScope(upstream abort + 超时合并)
  -> build extraction prompt(按 task 拼 prompt)
  -> convert image inputs into provider content parts(bytes 转 base64 等)
  -> call provider endpoint(经 SDK, 带超时 + abort)
  -> parse provider JSON output(strict 抛错 / best_effort 降级)
  -> VisionExtractionResult
  -> finally: dispose signal + release 槽位(必清)
```

等待槽位的时间计入请求超时, 可通过调用方的 `AbortSignal` 取消。`finally` 必释放槽位, 无论成功 / 失败 / 超时 / abort, 否则 limiter 计数泄漏。

## 失败策略

Vision 把失败归一成稳定错误码，由 `classifyVisionError(error, context, timedOut)` 按 HTTP 状态、关键词和超时标记集中分类：

```text
vision/not_configured        未配置 provider
vision/invalid_request       参数非法(providerId / model 空, 无图片)
vision/unsupported_input     不支持的输入
vision/payload_too_large     超图数 / 字节上限
vision/concurrency_limited   等待队列满(retryable)
vision/timeout               超时(retryable)
vision/aborted               用户取消(不重试)
vision/auth_failed           401 / 403(不重试)
vision/rate_limited          429(retryable)
vision/provider_unavailable  5xx / 网络(retryable)
vision/context_too_large     413(不重试)
vision/output_parse_failed   LLM 输出解析失败(strict 抛此, best_effort 降级)
vision/provider_failed       兜底(不重试)
```

每个错误直接暴露 `retryable`、`providerId`、`model`、`task` 和 `status` 等已知字段，不再藏进 `meta`。超时与用户取消由 `VisionRequestScope` 区分。

## 解析模式

`parseMode` 控制 LLM 输出解析失败的策略:

- `strict`: 解析失败抛 `vision/output_parse_failed`(retryable)
- `best_effort`(默认): 降级成单 text block + warning, 不让整个提取挂掉

`parse.ts` 的 `parseVisionPayload` 流程: 剥 ` ```json ` 围栏 -> 提取 `{...}` 候选 -> `JSON.parse` -> 校验 `blocks` 结构(kind 合法性 / bbox 4 数 / text 或 markdown 至少一个)。

## 公共 API

```ts
const result = await vision.extract({
  providerId: 'openai-vision-main',
  model: 'gpt-4o-mini',
  task: 'ocr',
  inputs: [{
    kind: 'bytes',
    bytes,
    mimeType: 'image/png',
    source: { localPath: 'D:/demo/screenshot.png' },
  }],
});
```

结果同时含 `text` 和 `blocks`:

- `text`: 适合注入模型上下文
- `blocks`: 保留结构, 供文档预览、分块、provenance、布局感知检索用

`VisionRuntime` 还提供：

- `probe(providerId, model)`: 使用明确模型健康探测，并只返回稳定错误码
- `reload(configs)`: 热替换全部 provider 配置
- `upsertConfig(config)` / `removeConfig(providerId)`: 单条增删
- `getProtocol(providerId)`: 查询明确 Provider 配置使用的协议
