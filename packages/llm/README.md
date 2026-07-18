# @ema-agent/llm

LLM Facade。4 家 provider 协议(OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Gemini generateContent)归一化成统一 `LlmRequest`/`LlmStreamChunk`,上层 engine 不感知 provider 差异。含熔断、重试、消息兼容性降级、prompt cache 前缀哈希。

## 架构

```
LlmRequest(messages/tools/thinking/signal)
   │
   ▼
LlmRouter(Facade)
   ├─ catalog enrich(ModelsDevCatalog 补能力)
   ├─ validate(内容 + 能力校验,fail-closed)
   ├─ prepareHistoricalMessages(历史只读降级)
   └─ LlmStreamRuntime
        ├─ CircuitBreaker(per-provider 熔断)
        ├─ 首包前可重试(收到首 chunk 后不重试,防前端重复)
        └─ adapter.stream()
              ├─ OpenAiAdapter       (openai-llm,Chat Completions + DeepSeek reasoning_content)
              ├─ OpenAiResponsesAdapter(openai-responses-llm,OpenAI 原生 o-series)
              ├─ AnthropicAdapter    (anthropic-llm,Messages + thinking signature 往返)
              └─ GeminiAdapter       (gemini-llm,generateContent)
   │
   ▼
AsyncIterable<LlmStreamChunk>(text_delta/tool_use_delta/tool_use_complete/thinking_delta/thinking_complete/usage/done)
```

## 4 协议差异

| 维度 | openai(Chat) | openai-responses | anthropic | gemini |
|---|---|---|---|---|
| system | messages 里 | 顶层 `instructions` | 顶层 `system` | `systemInstruction` |
| assistant role | assistant | assistant | assistant | model |
| tool_use 增量 | `delta.tool_calls` | `arguments.delta` | `input_json_delta` | 无(直接 complete) |
| thinking 历史 | `reasoning_content` | 丢弃 | signature 往返 | 跳过 |
| prompt cache | 自动 | 自动 | `cache_control` 断点 | 自动 |
| audio 输入 | ✗ | ✗ | ✗ | ✓ |

OpenAI 兼容第三方(DeepSeek/硅基流动/Ollama 等)用 `openai-llm`(Chat);OpenAI 原生 o-series 用 `openai-responses-llm`。

## Facade

| Facade | 职责 |
|---|---|
| `LlmRouter` | 主入口:`stream`/`complete`/`probe`/`capabilitiesFor`/热重载配置。catalog enrich + validate + 降级 + runtime |
| `LlmAdapter` | 接口(仅 `stream`),4 个实现 |
| `ModelsDevCatalog` | models.dev api.json 解析,动态 model 能力查询 |

## 关键机制

- **熔断**: per-provider `CircuitBreaker`(closed/open/half-open),失败达阈值熔断,冷却后半开试探。`CircuitOpenError` 直接拒
- **重试**: `withRetry`(非流式,指数退避)+ 首包前重试(流式,收到首 chunk 前失败才重试,防前端重复)。`isRetryable`:429/网络/5xx
- **兼容性降级**: `prepareHistoricalMessages` 历史只读降级(占位符);`validateCurrentContent` 本轮 fail-closed(不支持直接拒,不偷偷丢)。两者策略不同:历史可损失,本轮不能丢
- **兼容性恢复**: `createCompatibilityRecovery`--provider 拒绝可选参数(temperature/thinking/toolChoice)时省略重试
- **usage 归一**: `createLlmTokenUsage` 统一 4 家 token 计数(含 cacheRead/cacheWrite/cacheEligible + cacheHitRate)
- **prompt cache**: `computePromptPrefixHash`(SHA-256,诊断前缀稳定性)+ `normalizeToolDefinitions`(工具定义规范化)。实际命中看 provider `usage.cacheReadInputTokens`
- **能力查询**: `ModelCapabilitySnapshot` + 3 工厂(catalog/manual/unknown);`capabilitiesFor` 查视觉/推理/工具/caching

## 错误

6 类:`LlmModelCapabilityError`(能力不兼容)/ `ContextWindowExceededError`(超窗口)/ `LlmProviderResponseError`(provider 错误响应)/ `LlmToolArgumentsParseError`(args JSON 解析失败)/ `CircuitOpenError`(熔断)/ `LlmStreamProtocolError`(流无 done 终态)。`normalizeLlmProviderError` 归一,`isAbortError`/`throwIfAbortError` 处理取消。

## 文件

| 文件 | 职责 |
|---|---|
| `router.ts` | `LlmRouter` Facade:stream/complete/probe/能力校验/热重载 + `createAdapter` 工厂 |
| `stream-runtime.ts` | `CircuitBreaker` + `LlmStreamRuntime`(熔断 + 首包前重试 + done 终态验证) |
| `adapters/openai.ts` / `openai-responses.ts` / `anthropic.ts` / `gemini.ts` | 4 协议 adapter |
| `adapters/base.ts` | `LlmAdapter` 接口 |
| `message-compatibility.ts` | 历史只读降级 + 本轮 fail-closed 校验 |
| `compatibility-recovery.ts` | provider 拒绝可选参数时省略重试 |
| `model-capabilities.ts` | `ModelCapabilitySnapshot` + 3 工厂 |
| `models-dev-catalog.ts` | models.dev api.json 解析 + 双重索引查询 |
| `usage.ts` / `prompt-cache.ts` / `validate.ts` / `retry.ts` | usage 归一 / 前缀哈希 / content 校验 / 非流式重试 |
| `types.ts` / `errors.ts` | 契约 |

## 不做

- 不含业务逻辑(不感知 session/turn/会话,engine 构造请求消费结果)
- 不存 API key(经 `credential` 包 `reveal` 后传入,`apps/core` provider loader 加载配置)
- 不执行工具(只产 `tool_use_complete` chunk,执行在 `tool-builtin`)
- 不做流式 delta 之外的处理(text 拼装/ACT 解析在 engine/emotion)
