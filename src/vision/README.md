# Vision

[中文](README-zh.md)

`@ema-agent/vision` extracts text, descriptions, document layout, or tables from images. A call submits the current images and task instructions through [LLM](../llm/README.md), then returns text, optional markdown, content blocks, and model-reported Token usage.

## Use

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

`VisionConnection` uses the LLM connection type. All four implemented LLM protocols can be selected, with a model that accepts images. The call function reuses one `CompleteLLM` for subsequent image tasks.

Images can be bytes, Base64, or URLs. Byte and Base64 inputs include a MIME type: PNG, JPEG, WebP, or GIF. Base64 inputs may contain a data-URL prefix or whitespace, which is removed before sending. Gemini rejects ordinary HTTP(S) image URLs here. Callers should pass downloaded bytes or use a Gemini Files/Cloud Storage URI supported by the selected service.

## Task and result

| Task | Requested output | Default maximum output Tokens |
| --- | --- | --- |
| `auto` | Readable text, or a short description when there is no readable text. | 2048 |
| `caption` | Scene, objects, UI state, and relevant visible details. | 1024 |
| `ocr` | Readable text in reading order, with useful line breaks. | 2048 |
| `layout` | Text and layout regions, headings, tables, and figures. | 4096 |
| `table` | Tables reconstructed as markdown where possible. | 4096 |

The default task is `auto`. `language` and `instruction` add guidance to the prompt. `maxOutputTokens` overrides the task default; `temperature` is forwarded when provided.

Each request contains one user message with the extraction prompt and images. It disables thinking and includes no conversation history or tool definitions. `createVisionCall` creates `completeLLM` through `createLLMCompletion(connection, modelId)`. Each `completeLLM(request)` sends one non-streaming SDK request and returns the full model result for Vision to parse.

The prompt requests JSON with `text`, optional `markdown`, and `blocks`. Block kinds include text, table, image, layout, formula, and caption. The parser accepts JSON, fenced JSON, or a JSON object surrounded by text. Invalid JSON and plain text are preserved as a text block. Missing block IDs are generated, unknown kinds become `text`, and blocks without text or markdown are discarded. If no valid blocks remain, the parser builds a text block from the top-level text or raw response.

`bbox` means `[x, y, width, height]`. The prompt requests normalized coordinates, but parsing only verifies four finite numbers. `confidence` is also only checked for a finite number. Neither field is a verified measurement or a guaranteed 0..1 value.

## Failures and cancellation

Empty model IDs, empty image lists or payloads, invalid output limits, and non-finite temperatures produce `VisionError` with `vision/invalid_request`. Unsupported Gemini URLs produce `vision/unsupported_input` before the LLM request. An empty visible response produces `vision/invalid_response`.

Other LLM failures are wrapped as `vision/call_failed`, preserving the original cause and numeric HTTP status when available. Cancellation through `signal` is propagated without wrapping it as a provider failure. Retry decisions stay with the caller; Vision executes one request.

## Integration and tests

The server's [turn wiring](../../apps/server/src/composition/turn.ts) supplies Vision for attachment descriptions when the chat model cannot receive images. A chat model that supports images receives them directly. [DescribeImage](../builtin-tools/tools/DescribeImageTool/describeImageTool.ts) and the [PDF reader](../builtin-tools/tools/FileReadTool/pdfReader.ts) use Vision for explicit image and document tasks. Attachment descriptions are cached by the attachment flow.

Start with [visionModel.ts](visionModel.ts) for request creation, [prompts.ts](prompts.ts) for task instructions and default budgets, and [parse.ts](parse.ts) for response handling.

```sh
pnpm --filter @ema-agent/vision test
pnpm --filter @ema-agent/vision typecheck
```

Tests cover single-request construction, protocol selection, invalid inputs, cancellation, JSON/text handling, task budgets, and the fixed prompt. Caller-provided language and instructions are kept as supplied rather than having their punctuation rewritten.
