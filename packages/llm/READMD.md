# @ema-agent/llm

`@ema-agent/llm` 是 EmaAgent 的 LLM 接入层。它只负责管理 Provider、缓存模型目录、调用流式聊天接口，并把底层 `@xsai/stream-text` 事件归一化成 EmaAgent 内部统一的 `ChatCompletionChunk`。

这个包不负责 session、prompt、mode 绑定、工具执行、SSE 落盘或 UI 状态。调用方必须显式传入 `providerId + modelId + messages`。

## 模块边界

这个包负责：

- Provider 配置的内存级 CRUD。
- 从环境变量生成本地开发默认配置。
- 远端模型列表拉取与模型目录缓存。
- 调用 `@xsai/stream-text` 发起流式聊天。
- 将 xsai 事件归一化为 `ChatCompletionChunk`。
- 用量费用估算。
- Provider 错误归一化，以及工具不支持错误识别。

这个包不负责：

- 不做 `chat / agent / narrative / title` 到模型的绑定。
- 不拼接艾玛人设 Prompt。
- 不执行工具，只透传工具定义和工具调用事件。
- 不写 SQLite，不发 SSE。
- 不做 fallback chain；fallback 应该由更上层 orchestrator 或 provider binding 层处理。

## 目录结构

```text
packages/llm/
  src/
    client.ts              # LlmClient：唯一运行时入口
    index.ts               # 对外导出
    providers/
      spec.ts              # Provider 配置类型
      presets.ts           # 从 env 生成默认 Provider 配置
      catalog.ts           # ProviderCatalog 内存注册表
    models/
      catalog.ts           # ModelCatalog 模型目录缓存
      fetch.ts             # 通过 /models 拉取远端模型
    stream/
      chat.ts              # 调用 @xsai/stream-text
      normalize.ts         # xsai event -> ChatCompletionChunk
    usage/
      cost.ts              # usage -> costUsd
      errors.ts            # provider 错误归一化
  test/
    client.test.ts
    providers/catalog.test.ts
    models/catalog.test.ts
    stream/normalize.test.ts
    usage/errors.test.ts
```

## 公开 API

从包入口导入：

```ts
import {
  LlmClient,
  createDefaultConfig,
  createOpenAiSpec,
  createAnthropicSpec,
  createGeminiSpec,
  createDeepSeekSpec,
  createOpenRouterSpec,
  createOllamaSpec,
  ProviderCatalog,
  ModelCatalog,
  fetchModels,
  estimateUsageCost,
  isToolUnsupportedError,
  normalizeProviderError,
} from "@ema-agent/llm"
```

主要类型：

```ts
import type {
  LlmChatRequest,
  LlmConfig,
  LlmProviderSpec,
} from "@ema-agent/llm"
```

## Provider 配置

Provider 配置使用 `LlmProviderSpec`，可以存入 SQLite，也可以通过 HTTP 传输。

```ts
interface LlmProviderSpec {
  id: ProviderId
  kind: ProviderKind
  displayName: string
  enabled: boolean
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
}
```

默认配置来自环境变量：

```ts
const config = createDefaultConfig(process.env)
const client = new LlmClient()
client.applyConfig(config)
```

当前预置 Provider：

| 函数 | kind | 默认 baseUrl |
|---|---|---|
| `createOpenAiSpec()` | `openai` | `https://api.openai.com/v1` |
| `createAnthropicSpec()` | `anthropic` | `https://api.anthropic.com` |
| `createGeminiSpec()` | `gemini` | `https://generativelanguage.googleapis.com/v1beta` |
| `createDeepSeekSpec()` | `openai-compatible` | `https://api.deepseek.com/v1` |
| `createOpenRouterSpec()` | `openai-compatible` | `https://openrouter.ai/api/v1` |
| `createOllamaSpec()` | `openai-compatible` | `http://127.0.0.1:11434/v1` |

常用环境变量：

```text
OPENAI_API_KEY
OPENAI_BASE_URL
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL
GEMINI_API_KEY
GEMINI_BASE_URL
DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL
OPENROUTER_API_KEY
OPENROUTER_BASE_URL
OPENROUTER_HTTP_REFERER
OPENROUTER_APP_TITLE
OLLAMA_ENABLED=1
OLLAMA_BASE_URL
OLLAMA_API_KEY
```

## LlmClient 用法

```ts
import { asId } from "@ema-agent/core-types"
import { LlmClient, createDefaultConfig } from "@ema-agent/llm"
import type { ModelId, ProviderId } from "@ema-agent/core-types"

const client = new LlmClient()
client.applyConfig(createDefaultConfig(process.env))

const stream = client.streamChat({
  providerId: asId<ProviderId>("openai"),
  modelId: asId<ModelId>("gpt-4o-mini"),
  messages: [
    { role: "system", content: "你是 EmaAgent 的测试助手。" },
    { role: "user", content: "你好" },
  ],
  temperature: 0.7,
  maxTokens: 1024,
})

for await (const chunk of stream) {
  if (chunk.delta.content) {
    process.stdout.write(chunk.delta.content)
  }
}
```

`streamChat()` 会在以下情况抛出错误：

- Provider 不存在。
- Provider 被禁用。
- 底层 `@xsai/stream-text` 抛错。
- xsai 流里出现 `error` 事件。

## 流式事件归一化

`src/stream/normalize.ts` 负责把 xsai 事件转为 `ChatCompletionChunk`。

当前处理规则：

| xsai event | EmaAgent 输出 |
|---|---|
| `text-delta` | `delta.content` |
| `tool-call-streaming-start` | `toolCalls[].argumentsDelta = ""` |
| `tool-call-delta` | `toolCalls[].argumentsDelta` |
| `finish` | `finishReason` + `usage` |
| `error` | 直接抛出错误 |
| `tool-call` / `tool-result` / `reasoning-delta` | 当前忽略 |

`finishReason` 映射：

```text
stop            -> stop
length          -> length
tool-calls      -> tool_calls
content_filter  -> content_filter
error           -> error
unknown         -> null
```

## 工具调用

调用方可以在 `LlmChatRequest.tools` 传入 `ToolSpec[]`。

本包只做两件事：

1. 把 EmaAgent 的工具描述转换成 xsai/OpenAI 风格函数工具。
2. 把模型返回的工具调用流转成 `ChatCompletionChunk.toolCalls`。

本包不会执行工具。工具调用应该交给 `tool` package 或上层 agent loop 执行。

## 模型目录

`refreshModels(providerId)` 会调用 `fetchModels()` 并写入 `ModelCatalog`。

```ts
await client.refreshModels(asId<ProviderId>("openai"))
const models = client.listModels(asId<ProviderId>("openai"))
```

当前模型拉取逻辑：

- `openai`、`openai-compatible`、`gemini` 走 `GET {baseUrl}/models`。
- `anthropic` 当前返回空数组，因为没有统一的标准 list endpoint。
- `local-dev` 当前返回空数组。

返回模型会使用 `FALLBACK_CONTEXT_WINDOW` 和 `FALLBACK_MAX_OUTPUT_TOKENS` 作为兜底元数据。

## 用量与费用

`estimateUsageCost()` 在已有 `UsageView` 上追加 `costUsd`。

```ts
const usage = estimateUsageCost({
  providerId: asId<ProviderId>("openai"),
  modelId: asId<ModelId>("gpt-4o-mini"),
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
  },
})
```

定价数据来自 `@ema-agent/constants-core` 的 `DEFAULT_PRICING`。如果模型没有定价，函数会原样返回 usage。

## 错误处理

`normalizeProviderError(error)`：

- 如果入参是 `Error`，原样返回。
- 其它值转成 `Error(String(value))`。

`isToolUnsupportedError(error)`：

- 用正则匹配常见“模型不支持工具/函数调用”的 provider 错误。
- 返回 `true` 时，上层应该缓存该模型不支持工具，避免重复失败。

## 测试

```bash
pnpm --filter @ema-agent/llm test
pnpm --filter @ema-agent/llm typecheck
```

当前测试覆盖：

- `LlmClient` provider 管理与 `streamChat()` 委托。
- `ProviderCatalog` CRUD。
- `ModelCatalog` 缓存行为。
- xsai 流事件归一化。
- 工具不支持错误识别。

## 开发约束

- 新 Provider 优先通过 `LlmProviderSpec.kind` 和 `@xsai/stream-text` 兼容层接入。
- 不要在本包里写业务 prompt。
- 不要在本包里保存用户消息或 session 状态。
- 不要在本包里执行工具。
- 不要把 role binding 写进 `LlmClient`；绑定关系应该由 API / settings / orchestrator 层维护。
- 对外新增 API 时必须从 `src/index.ts` 导出，并补对应测试。

## 后续 TODO

- 支持真实 provider health check。
- 为 Anthropic 增加手动模型预设或专用模型列表来源。
- 为工具不支持错误增加模型级缓存接口。
- 把 `reasoning-delta` 归一化成内部 reasoning 事件。
- 根据 provider kind 精细化 `/models` 解析和鉴权策略。
