# `@ema-agent/llm`

最后更新: 2026-06-03

`@ema-agent/llm` 是 EmaAgent 的 LLM Facade。调用方只和 `LlmRouter`、`LlmRequest`、`LlmStreamChunk` 打交道，不直接依赖 OpenAI、Anthropic、Gemini 等 SDK。

## 架构

```text
apps/core 或 agent 包
  -> LlmRouter
    -> OpenAiAdapter          openai-llm
    -> OpenAiResponsesAdapter openai-responses-llm
    -> AnthropicAdapter       anthropic-llm
    -> GeminiAdapter          gemini-llm
      -> provider SDK / HTTP stream
```

路由 key 是 `ProviderConfig.id`，不是 protocol。DeepSeek、SiliconFlow、Moonshot 这类供应商都可以使用 `openai-llm` 协议，但必须各自拥有独立 provider config id。

```ts
interface ProviderConfig {
  id: string;
  protocol: LlmProtocol;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}
```

## 请求

```ts
interface LlmRequest {
  providerId: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  thinking?: ThinkingMode;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}
```

`LlmMessage` 使用 Anthropic 风格的 block model 作为包内规范格式：

```ts
type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserBlock[] }
  | { role: 'assistant'; content: AssistantBlock[] };
```

工具结果不使用独立 `role: 'tool'`，而是作为 `ToolResultBlock` 放在下一条 `role: 'user'` 消息里。各 adapter 自己转换成 provider wire format。

## Streaming Contract

所有 adapter 都返回统一的 `AsyncIterable<LlmStreamChunk>`。

```ts
type LlmStreamChunk =
  | { type: 'text_delta'; blockIndex: number; delta: string }
  | { type: 'thinking_delta'; blockIndex: number; delta: string }
  | { type: 'thinking_complete'; blockIndex: number; signature: string }
  | { type: 'tool_use_delta'; blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; blockIndex: number; callId: string; name: string; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: StopReason };
```

`blockIndex` 是 assistant block 数组里的位置。常见约定：

- no thinking: text 通常是 `0`
- thinking + text: thinking 是 `0`，text 是 `1`
- OpenAI Chat Completions 工具调用: `1000 + toolIndex`
- Anthropic 工具调用: provider 原始 content block index

## Router

`LlmRouter.stream()` 只做 provider id -> adapter 的同步路由。未知 provider 会同步抛 `provider/not_configured`，便于上游 fail-fast。

`LlmRouter.complete()` 是 `stream()` 的聚合器，用于 compaction、内部分类、健康检查等非 UI 流式场景。它会把 text/thinking/tool chunks 重建成 `AssistantBlock[]`，并按 `blockIndex` 排序。

Retry 边界：

- 连接建立前失败，且错误可重试时，最多重试 3 次。
- 已经收到任意 chunk 后失败，不重试，避免重复消耗 token 和产生不同结果。

## Thinking V1

V1 支持 thinking 控制和展示，不承诺完整 provider continuation round-trip。

```ts
type ThinkingMode =
  | { enabled: 'auto'; effort?: 'high' | 'max'; budgetTokens?: number; includeThoughts?: boolean }
  | { enabled: true; effort?: 'high' | 'max'; budgetTokens?: number; includeThoughts?: boolean }
  | { enabled: false };
```

当前已实现：

- `openai-llm` 显式传入 `thinking` 时，会发送 DeepSeek 兼容字段。
- DeepSeek/OpenAI-compatible 的 `delta.reasoning_content` 会规范化成 `thinking_delta`。
- Anthropic stream 会读取 `thinking_delta` 和 `signature_delta`，并在 thinking block 结束时 emit `thinking_complete`。
- `complete()` 会把 `thinking_complete.signature` 聚合回 `AssistantBlock.signature`。

OpenAI-compatible thinking 参数映射：

```ts
thinking: { enabled: false }
// -> { thinking: { type: 'disabled' } }

thinking: { enabled: true, effort: 'max' }
// -> { thinking: { type: 'enabled' }, reasoning_effort: 'max' }

thinking: { enabled: 'auto', effort: 'high' }
// -> { reasoning_effort: 'high' }
```

默认不传 `thinking` 时，不发送 provider-specific thinking 字段，避免影响普通 OpenAI-compatible provider。

V1 暂不处理：

- DeepSeek/Kimi/Zhipu 等 provider 的完整 `reasoning_content` continuation 回传。
- Gemini `thinkingConfig` / `thoughtSignature`。
- MiniMax `<think>...</think>` 的 provider-specific history 保留。
- 压缩后保留 provider thinking continuation。

压缩边界原则：

```text
summary 可以保留 thinking 的语义摘要；
summary 不能伪装成 provider 原始 thinking continuation。
```

如果历史被压缩，调用方应视为 fresh context，丢弃 provider continuation 状态。

## Adapter 状态

| Adapter | Protocol | 当前能力 | Thinking 状态 |
| --- | --- | --- | --- |
| `OpenAiAdapter` | `openai-llm` | text、image、wav/mp3 audio、tool calling | DeepSeek-style control + `reasoning_content` streaming |
| `OpenAiResponsesAdapter` | `openai-responses-llm` | Responses API text、image/file、tool calling | o-series reasoning summary -> `thinking_delta` |
| `AnthropicAdapter` | `anthropic-llm` | text、image、file、tool use | thinking/signature stream + history round-trip when signature exists |
| `GeminiAdapter` | `gemini-llm` | text、image/file/audio data、function calling | V1 暂未接入 `thinkingConfig`/`thoughtSignature` |

## Model Catalog

`ModelCatalog` 用 `protocol:model` 做 key，不使用 provider instance id。

```ts
catalog.get('openai-llm', 'deepseek-v4-flash');
catalog.get('openai-responses-llm', 'o4-mini');
catalog.get('anthropic-llm', 'claude-sonnet-4-5');
```

Catalog 只描述模型能力，运行时 provider 实例仍由 `LlmRouter` 的 `providerId` 决定。

## Tests

默认测试不访问真实网络：

```powershell
pnpm --filter @ema-agent/llm test
pnpm --filter @ema-agent/llm typecheck
```

默认 suite 当前覆盖：

- `router.test.ts`: routing、hot reload、`getProtocol()`、`complete()` 聚合、retry 边界
- `openai-adapter.test.ts`: OpenAI-compatible thinking 参数和 `reasoning_content` 规范化
- `catalog.test.ts`: static model catalog
- `validate.test.ts`: content-part compatibility
- `retry.test.ts`: retry helper

Live tests 被 `vitest.config.ts` 默认排除。显式运行 live tests 时需要打开开关：

```powershell
$env:DEEPSEEK_API_KEY = '...'
$env:EMA_AGENT_RUN_LIVE_TESTS = '1'
pnpm --filter @ema-agent/llm exec vitest run tests/live-deepseek-protocol-diff.test.ts --reporter verbose
```

`live-deepseek-protocol-diff.test.ts` 覆盖：

- DeepSeek OpenAI-compatible URL text stream
- DeepSeek Anthropic-compatible URL text stream
- OpenAI vs Anthropic parallel tool-call yield timing
- OpenAI-compatible two-turn `complete()` with previous assistant blocks

不要把 API key 写入测试文件或 README。

## 添加新供应商

如果新供应商复用现有协议，只改 contracts provider registry 和 model catalog；不要新增 adapter。

```text
OpenAI-compatible provider
  -> contracts/src/providers/<provider>/index.ts
  -> contracts/src/providers/registry.ts
  -> packages/llm/src/catalog.ts
```

如果是新 wire protocol：

```text
1. contracts: 增加 ProtocolFamily / LlmProtocol
2. packages/llm/src/adapters/<provider>.ts: 实现 LlmAdapter
3. router.ts: createAdapter() 增加分支
4. validate.ts: 增加 content-part 兼容检查
5. catalog.ts: 增加模型条目
6. tests: 添加 adapter 单测和必要 live smoke
```

## 后续更新记录

- 2026-06-03: 增加 `ThinkingMode`、OpenAI-compatible DeepSeek thinking 参数、OpenAI adapter 单测、DeepSeek protocol diff live test。
- 2026-06-03: `LlmRouter` 以 `ProviderConfig.id` 作为唯一可用性事实来源；adapter override 只用于已注册 provider config 的测试替换。
- 2026-06-03: 默认 Vitest 排除 `tests/live-*.test.ts`，通过 `EMA_AGENT_RUN_LIVE_TESTS=1` 手动开启 live tests。
