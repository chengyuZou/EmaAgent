# LLM

[中文](README-zh.md)

`@ema-agent/llm` sends model requests through OpenAI, Anthropic, or Gemini SDKs. It accepts shared messages and tool definitions, then returns stream events or a complete result with content blocks, stop reason, and Token usage.

## Use

Create a call function for a resolved connection and model. Choose how to receive each request's result.

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

For incremental output, use this instead of `createLLMCompletion`:

```ts
const callLLM = createLLMCall(connection, modelId);

for await (const event of callLLM(request)) {
  // Handle text, thinking, tool calls, usage, and done events.
}
```

Both factories take a connection and model ID, then return a function that accepts `LLMRequest`. `CallLLM` returns events; `CompleteLLM` returns a Promise of `LLMCompletion`. Each invocation executes one model request. Running both executes two requests.

The completion function creates and consumes a streaming request internally. Callers supply connection, model and request only, not a CallLLM. Each request owns its stream and collected blocks; the factory reuses the SDK client. Success returns LLMCompletion, while cancellation or failure closes the stream and rejects the request.

Both factories copy the connection at creation. Changing the original object later does not change that function. Protocol and SDK initialization happen on the first request, or the first consumed stream for `CallLLM`. Concurrent and later requests through the same function share its initialization and client. Independently created functions have separate clients.

The current SDK dependencies require Node >=22. See [package.json](package.json) for versions. The desktop release uses the Node version in [release-config.json](../../apps/desktop/release-config.json).

## Request path

```text
Resolved connection + modelId
    -> createLLMCall -> callLLM(request)
        -> one streaming SDK request -> events consumed by Agent
    OR
    -> createLLMCompletion -> completeLLM(request)
        -> one streaming SDK request -> collect ordered blocks -> LLMCompletion
```

[types.ts](types.ts) defines connection, request, result, and event types. [message.ts](message.ts) defines messages: system text, user text/media/tool results, and assistant content blocks. Tool definitions use `LLMTool.inputSchema`. Tool replies are user `tool_result` blocks paired through `toolCallId`.

The protocol is selected using `LLMProtocol` from [providers](../providers/README.md):

| Protocol | API | Tool-result images |
| --- | --- | --- |
| `openai-llm` | Chat Completions | Each image becomes an explicit text placeholder. It states that the image was not read and suggests DescribeImage when available. |
| `openai-responses-llm` | Responses | Native text/image content in `function_call_output.output`, with the original `call_id`. |
| `anthropic-llm` | Messages | Images inside `tool_result.content`. |
| `gemini-llm` | generateContent | Text/JSON in `functionResponse`, followed by images labeled with their source after the tool-result batch. |

These conversions produce SDK input without changing stored messages. Chat does not append a user image to work around its tool-message format. Gemini does not put image Base64 into ordinary JSON.

[protocolInput.ts](protocolInput.ts) checks supported content before the SDK runs. The Chat implementation rejects file blocks and accepts only WAV/MP3 audio. Responses and Anthropic reject audio blocks. Anthropic inline images must be JPEG, PNG, GIF, or WebP. These checks describe the implemented conversions; individual models and gateways can impose further limits.

Assistant text and tool calls remain usable when the model changes. Native thinking state is replayed only when `generatedBy.providerId`, `modelId`, and `protocol` match the current target. This includes Anthropic signatures, Responses reasoning items, and Gemini thought signatures. `cacheBreakpoint` becomes an Anthropic cache marker; other protocols ignore it.

`thinking.enabled: 'auto'` leaves the thinking toggle at the provider default. Anthropic and Gemini convert effort to Token budgets in their protocol files. These project mappings do not imply equivalent reasoning across providers. Anthropic's enabled thinking also needs an output budget large enough for its minimum thinking budget.

The public request keeps only `thinking.enabled` and `thinking.effort`. Chat Completions first builds its usual `thinking` / `reasoning_effort` fields, then privately maps verified supplier differences inside `protocols/openAiChat.ts`. The official `api.siliconflow.cn` and `api.siliconflow.com` hosts receive `enable_thinking` derived from `thinking.type`, without also receiving `thinking`. That wire field is not a public request or configuration option. SiliconFlow effort is sent only for the model IDs listed in that function, using `high` or `max`; no Token budget is invented for other models. Other hosts keep the existing Chat mapping. A custom Provider ID at an official SiliconFlow address receives the same conversion; an arbitrary gateway is not classified by its display name. See the [SiliconFlow request fields](https://docs.siliconflow.cn/docs/api/chat-completions-post) and [DeepSeek thinking fields](https://api-docs.deepseek.com/guides/thinking_mode/).

`maxOutputTokens` is the caller's request budget, not a command to use the model's full output capacity. Completion uses streaming transport, including for large output budgets. Narrative still supplies its own fixed 8192 output budget.

## Events, usage, and failures

Content events carry `blockIndex`. Use it to join deltas and preserve the final order of text, thinking, and tool calls. `tool_use_complete` supplies parsed arguments. A successful protocol stream ends with an explicit `done`. An unexpected disconnect throws `LLMStreamProtocolError`.

`CompleteLLM` converts the response's text, thinking state, and tool calls into ordered blocks. Its result is the full `LLMCompletion`, not just visible text. Responses preserves the order of its `output` items; Anthropic preserves content order; Gemini preserves part order. Chat supplies separate thinking, text, and tool-call fields, which are placed in that order.

Usage events report cumulative counts for one request. `updateLLMCallUsage` returns the greatest known counts and the increase since the previous report. Adding raw usage events would count repeated reports twice. Cache-read and cache-write counts are already included in `inputTokens`.

An empty model ID fails at factory creation. Unsupported message content fails synchronously in `callLLM(request)` and rejects the Promise in `completeLLM(request)`. SDK initialization and network failures propagate through the selected return type. Invalid tool-argument JSON throws `LLMToolArgumentsParseError`. Context-length errors become `ContextWindowExceededError`, allowing the caller to decide whether to compact and retry.

Both entry points require a terminal stream event. Output limits map to max_tokens; content-filter stops map to stop_sequence. Provider failures and incomplete streams reject the request without polling or replay.

Pass `request.signal` to cancel. A request already cancelled when it starts does not initialize the SDK. Cancellation during shared initialization stops that request after initialization finishes, without cancelling other requests. Cancellation and failures do not produce a successful `done` or a completion result.

OpenAI and Anthropic clients disable built-in retries. Gemini is called without retry options. This package does not automatically repeat failed requests. Streaming Chat waits up to 60 seconds for the next chunk and up to 2 seconds for trailing usage after a finish reason, so a gateway that never closes its stream does not keep the caller waiting indefinitely.

HTTP 413 without a specific context-length error is reported as `provider/request_too_large` through `LLMRequestTooLargeError`. It is not a generic server failure or an automatic request to retry compaction.

## Read and verify

Start with [languageModel.ts](languageModel.ts) for both factories and their lazy initialization. Follow [protocols/](protocols/) for shared request conversion, streaming events, and completion collection. [usage.ts](usage.ts) and [errors.ts](errors.ts) contain shared counting and failure rules.

Consumers include [Agent](../agent/agentLoop.ts), [Compact](../compact/macroCompact.ts), [Vision](../vision/visionModel.ts), and the server's [Memory](../../apps/server/src/composition/memory.ts) and [Narrative](../../apps/server/src/composition/narrative.ts) wiring.

```sh
pnpm --filter @ema-agent/llm test
pnpm --filter @ema-agent/llm typecheck
```

[tests/languageModel.test.ts](tests/languageModel.test.ts) covers initialization, client reuse, request parameters, failures, and cancellation. Protocol tests check message conversion, stream events, and [collected results](tests/completionProtocols.test.ts). [tests/sdkRequests.test.ts](tests/sdkRequests.test.ts) runs the installed SDKs against a local HTTP/SSE server to check streaming endpoints for both entry points, single-request execution, rate-limit failures without retry, and cancellation. These tests do not call paid model services.
