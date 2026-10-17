# Embedding

[中文](README-zh.md)

`@ema-agent/embed` sends batches of text to an Embedding API and returns vectors in the same order as the input. It checks the returned vector count and dimensions, then applies L2 normalization when the vector has a finite, nonzero norm. Zero vectors and vectors whose norm cannot be represented as a finite number are left unchanged.

## Use

```ts
import { createEmbedCall } from '@ema-agent/embed';

const embed = createEmbedCall({
  protocol: 'openai-embed',
  baseUrl: 'http://127.0.0.1:8080/v1',
}, 'embedding-model');

const result = await embed({ texts: ['First passage', 'Second passage'] });
// result.embeddings[0] belongs to the first text.
// result.dim is the number of components in each vector.
```

The model and protocol are selected when the call is created. Each call accepts `texts` and an optional `signal`. An empty batch returns `{ embeddings: [], dim: 0 }` without a request; an empty text inside a nonempty batch is rejected.

| Protocol | Request | Default base URL |
| --- | --- | --- |
| `openai-embed` | `POST /embeddings` with float output | `https://api.openai.com/v1` |
| `gemini-embed` | `POST /models/{modelId}:batchEmbedContents` | `https://generativelanguage.googleapis.com/v1beta` |

A configured `baseUrl` replaces the default. OpenAI-compatible responses are reordered by their `index`; Gemini responses retain their returned order. Both paths check that every input has one finite-valued vector of the same positive dimension.

`usage.inputTokens` is included when the OpenAI-compatible response supplies a valid `prompt_tokens`. The Gemini implementation currently returns vectors without usage. Missing usage is not estimated here.

## How the application uses it

Server [composition/narrative.ts](../../apps/server/src/composition/narrative.ts) reads the `narrative-embed` binding, resolves its provider connection, creates a `CallEmbed`, and records the returned usage. [Narrative recall](../narrative/pipeline/recall.ts) submits query texts and matches each returned vector to its text. Narrative also checks the dimension required by its bundled assets. Provider health checks use the same API entry point with a small test input.

Each call makes one HTTP request. The caller supplies cancellation or a timeout through `signal` and decides whether to retry. HTTP failures and malformed responses raise `EmbeddingError` with a code, an optional HTTP status, and an optional cause. Network and cancellation errors from `fetch` propagate as received. HTTP error messages include at most 500 characters of the provider's response body.

Implementation starts at [embeddingModel.ts](embeddingModel.ts); the two files in [protocols](protocols) build and read the HTTP requests.

```sh
pnpm --filter @ema-agent/embed test
```

Tests replace `fetch` to inspect request URLs and headers, input ordering, response validation, normalization, and empty batches. They do not contact a paid provider.
