# `@ema-agent/vision`

`@ema-agent/vision` is EmaAgent's independent visual extraction capability.

It accepts images, screenshots, scanned pages, and future video frames, then
returns text / markdown / structured blocks for turn attachments, document
ingestion, knowledge-base indexing, and Ema's live visual ability.

## Boundary

```text
attachments / document ingest / knowledge ingest / Ema visual features
  -> VisionRouter
    -> provider id -> VisionAdapter
      -> provider vision endpoint
```

Vision does not own file storage, attachment metadata, chunking, vector indexes,
or knowledge-base lifecycle. It only turns visual input into a stable
`VisionExtractionResult`.

Vision is also independent from `@ema-agent/llm`. A vision provider may expose an
OpenAI-compatible chat-completions wire format, but the Vision package owns that
adapter itself. Core wiring should treat vision the same way it treats LLM, TTS,
STT, EBD, and rerank: separate provider configs, separate router, separate
capability surface.

## Runtime Shape

Production wiring should create one `VisionRouter` in `apps/core` and expose it
through `AppBindings`.

```text
buildBindings()
  -> vision = new VisionRouter({
       configs: visionProviderConfigs,
       limits,
     })

routes / orchestrator / attachment ingest / knowledge ingest
  -> bindings.vision.extract(...)
```

`VisionRouter` keeps only provider config, adapter instances, and lightweight
concurrency counters. Per-call images, prompts, parse state, and abort
controllers stay local to `extract()`, so chat, attachments, and knowledge-base
jobs cannot overwrite each other's request state.

## Provider Model

```ts
const vision = new VisionRouter({
  configs: [{
    id: 'openai-vision-main',
    protocol: 'openai-vision',
    apiKey,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  }],
});
```

The current adapter is `openai-vision`, which targets `/v1/chat/completions`
with multimodal content parts. OpenAI-compatible providers such as SiliconFlow
can use the same protocol with their own base URL and model names.

## Data Flow

```text
VisionRequest
  -> normalize task / parse mode
  -> validate image count and byte budgets
  -> wait for a global + per-provider concurrency slot (bounded queue)
  -> build extraction prompt
  -> convert image inputs into provider content parts
  -> call provider endpoint
  -> parse provider JSON output
  -> VisionExtractionResult
```

`VisionRequest.task` is optional for callers and defaults to `auto`. Adapters
receive a normalized request where `task` and `parseMode` are always present.

## Failure Policy

Vision classifies failures into stable error codes:

```text
vision/not_configured
vision/invalid_request
vision/unsupported_input
vision/payload_too_large
vision/concurrency_limited
vision/timeout
vision/aborted
vision/auth_failed
vision/rate_limited
vision/provider_unavailable
vision/context_too_large
vision/output_parse_failed
vision/provider_failed
```

The router enforces request size, image count, global concurrency,
per-provider concurrency, bounded queue size, timeout, and strict/best-effort
output parsing. Waiting for a slot is included in the request timeout and can be
cancelled through the caller's `AbortSignal`. Per-request limits may tighten but
cannot raise the router-level hard limits.

## Public API

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

The result intentionally contains both `text` and `blocks`. `text` is suitable
for model context injection. `blocks` preserves structure for document preview,
chunking, provenance, and later layout-aware retrieval.
