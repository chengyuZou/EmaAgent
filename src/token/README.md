# @ema-agent/token

[中文](./README-zh.md)

Estimate how many tokens a string or a model request contains. Both public functions run synchronously and return a number. Ema uses these estimates to budget context, decide when to compact history, limit returned text, and show approximate output usage while a reply streams.

## Usage

```ts
import type { LlmTool, Message } from '@ema-agent/llm';
import { estimateMessagesTokens, estimateTextTokens } from '@ema-agent/token';

const messages: readonly Message[] = [
  { role: 'system', content: 'Answer briefly.' },
  { role: 'user', content: 'Hello.' },
];
const tools: readonly LlmTool[] = [{
  name: 'Read',
  description: 'Read a file at the given path.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

const textTokens = estimateTextTokens('abcd'); // 1
const inputTokens = estimateMessagesTokens(messages, tools);
const toolsTokens = estimateMessagesTokens([], tools);
```

| Function | Input | Result |
| --- | --- | --- |
| `estimateTextTokens(text)` | A string. | Estimated text tokens. |
| `estimateMessagesTokens(messages, tools?)` | `Message[]` and optional `LlmTool[]` from `@ema-agent/llm`. Both arrays may be readonly. | Estimated tokens for all supplied messages and tool definitions. |

For a complete request estimate, include the system prompt, current effective history, new messages, and available tool definitions. Tool results already belong to the messages. Count each result once. An empty string returns `0`. Empty message and tool arrays return `0`.

## How data reaches the estimate

For a normal model call:

1. The caller prepares model messages. Saved attachment paths become image, text, or other model content blocks before estimation. For images handled through Vision, the description text is what gets counted.
2. [`assembleContext`](../context/assembleContext.ts) builds system messages from prompt blocks, places them before the working messages, and converts the current tool pool to `LlmTool[]`.
3. [`estimateContextUsage`](../context/contextUsage.ts) passes these messages and tools to `estimateMessagesTokens`. The returned number becomes `estimatedInputTokens`.
4. [`prepareAgentIteration`](../turn/prepare/prepareAgentIteration.ts) passes that estimate to Compact to check the request budget. Compact estimates candidate histories and summary requests with the same function. The prepared context usage also feeds the desktop context meter. When a provider reports usage for a call, Context can use its input count for that call.

The returned number describes the supplied input. The caller compares it with the selected model's context window and budgets any output separately. The estimate is made before provider-specific request conversion, so it can differ from the provider's count.

Other callers use the same two functions:

- [Manual compaction](../commands/compact/compactSession.ts) measures history before accepting `/compact`, then includes the system messages in the compaction request estimate.
- [Memory summaries](../memory/common/memorySummary.ts) and [Memory file reads](../memory/common/memoryFiles.ts) use text estimates to fit content within their budgets.
- [Scratchpad tools](../builtin-tools/tools/ScratchpadTool/ScratchpadTools.ts) return estimated token counts with entry contents.
- The desktop [reply footer](../../apps/desktop/src/chat/messages/TurnFooter.tsx) estimates visible reply text while output usage is unavailable.

## Counting rules

Text is counted in UTF-16 code units, the units used by JavaScript string indexing. For each string, the estimate is `ceil(ASCII units / 4 + other units / 1.5)`. For example, `abcd` gives `1`, `abcd你好` gives `3`, and `😀` gives `2` because that emoji occupies two code units.

| Content | Calculation |
| --- | --- |
| Message format | Add `10` per message, including a message with empty content. |
| Text and visible reasoning text | Apply the text rule to each string or content block, then add the results. For `reasoning`, count `summaryText` when present. |
| Image, including an image in a tool result | With positive finite dimensions, use `ceil(width * height / 750)`, limited to `85` through `5,334`. Otherwise use `5,334`. |
| Audio | With a positive finite `durationMs`, use `ceil(durationMs / 1,000 * 32)`, with a minimum of `1`. Otherwise use `8,000`. |
| Document | With a positive finite `pageCount`, use `ceil(pageCount) * 2,000`. Otherwise use `8,000`. |
| Tool call | Add `20` to the text estimate of its JSON-serialized arguments. If serialization throws, the arguments contribute `1,000`, for a total of `1,020`. |
| Tool definition | Add `20` to the text estimate of JSON containing `name`, `description`, and `parameters` from `inputSchema`. If serialization throws, the entire definition contributes `1,000`. |
| Tool result | Count its text or each of its text and image parts. |

Rounding happens for each text string or block. Splitting the same text across more blocks can change the total. Media estimates use dimensions, duration, or page count rather than the length of a URL or Base64 string.

These rules are local approximations shared across models. Format allowances and media defaults can be lower or higher than actual usage. Use provider usage for reported consumption and billing.

## checking the code

From the repository root:

```sh
pnpm --filter @ema-agent/token test
pnpm --filter @ema-agent/token typecheck
```
