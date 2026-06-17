# `@ema-agent/vision`

`@ema-agent/vision` is the thin visual text extraction Facade for EmaAgent.

It converts images, screenshots, scanned pages, and future video frames into
text that can be consumed by attachments, document ingestion, knowledge base
indexing, and Ema's own visual ability.

## Boundary

```text
attachments / document / knowledge / Ema visual features
  -> VisionClient
    -> LlmRouter
      -> provider adapters
```

Vision does not own file storage, attachment metadata, chunking, vector indexes,
or knowledge base lifecycle. It only turns visual input into a stable
`VisionExtractionResult`.

## Provider Boundary

Vision does not expose a backend selector. Callers provide the configured
provider id and model:

```ts
await vision.extract({
  providerId,
  model,
  task: 'ocr',
  inputs,
});
```

Qwen-VL, GPT-4o, Claude Vision, Gemini, or any OpenAI-compatible vision model are
all provider/model choices. Sending images to a provider remains the job of the
LLM Facade supplied by `apps/core`; Vision does not duplicate provider wire
protocols and does not own provider lifecycle.

The package depends only on `@ema-agent/contracts` types. `apps/core` injects an
object compatible with `VisionLlmFacade`, normally the existing `LlmRouter`.

## Lifecycle

Production wiring should create one `VisionClient` in `apps/core` and expose it
as `bindings.vision`.

```text
buildBindings()
  -> llm = new LlmRouter(...)
  -> vision = new VisionClient({ llm })

routes / orchestrator / document ingest / attachment ingest
  -> bindings.vision.extract(...)
```

`VisionClient` does not store per-request payloads or results on the instance.
Each call keeps prompt, content parts, parse state, and abort controller in local
variables, so concurrent calls cannot overwrite each other.

The process-wide concurrency limiter is shared by default. This keeps global and
per-provider budgets effective even if a future caller accidentally constructs a
new `VisionClient` instead of using `bindings.vision`.

## Data flow

```text
VisionRequest
  -> build extraction prompt
  -> MessageContentPart[] with image_data / image_url
  -> LlmRouter.warnUnsupportedParts()
  -> LlmRouter.complete()
  -> parse JSON payload
  -> VisionExtractionResult
```

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

`VisionClient` also enforces request size, image count, per-provider concurrency,
global concurrency, timeout, and strict/best-effort output parsing.

## Public API

```ts
const vision = new VisionClient({ llm });

const result = await vision.extract({
  providerId: 'provider-config-id',
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

The result intentionally contains both `text` and `blocks`. `text` is easy for
LLM context injection, while `blocks` keeps enough structure for document
preview, chunking, provenance, and later layout-aware retrieval.
