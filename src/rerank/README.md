# Rerank

[中文](README-zh.md)

`@ema-agent/rerank` sends a query and candidate texts to a Rerank API. It returns document indices and provider scores, sorted from highest to lowest score.

## Use

```ts
import { createRerankCall } from '@ema-agent/rerank';

const rerank = createRerankCall({
  protocol: 'cohere-rerank',
  baseUrl: 'http://127.0.0.1:8080/v2',
}, 'rerank-model');

const result = await rerank({
  query: 'How does the story end?',
  documents: ['First candidate', 'Second candidate'],
  topK: 2,
});
// Each result.index points into the original documents array.
```

The factory selects the model and protocol. Calls accept `query`, `documents`, optional `topK`, and optional `signal`. `topK` defaults to at most 5 documents and is capped at the number of candidates. An empty candidate list returns `{ results: [] }` without a request. The query must still be nonblank.

`cohere-rerank` sends `POST /rerank` with `model`, `query`, `documents`, and `top_n`. Its default base URL is `https://api.cohere.com/v2`; callers can supply a compatible server instead. Authentication uses a Bearer header when an API key is present.

The response accepts `relevance_score` or `score`. Indices must be unique and within the original candidate array, scores must be finite, and the result count cannot exceed the requested limit. Equal scores are ordered by original document index.

Scores keep the provider's original scale. Rescaling each batch between its lowest and highest score would make a threshold depend on the other candidates in that batch.

## Usage, failures, and application calls

Token usage comes from `meta.tokens.input_tokens` and optional `output_tokens`. A compatible response's `usage.total_tokens` is a fallback for the input amount. Missing usage remains absent; `billed_units.search_units` is not a Token count.

Each call sends one request. The caller passes cancellation or a timeout through `signal` and decides whether to retry. HTTP errors and malformed responses raise `RerankError`, carrying a code, optional HTTP status, and optional cause. Network and cancellation errors from `fetch` propagate as received. HTTP error messages include at most 500 characters of the provider's response body.

Server [composition/narrative.ts](../../apps/server/src/composition/narrative.ts) creates the call from the `narrative-rerank` binding and records usage. [Narrative recall](../narrative/pipeline/recall.ts) sends the original query and candidate passage contents, then uses the returned indices to select passages. Provider health checks also use `createRerankCall`.

Read [reranker.ts](reranker.ts) for input checks, sorting, and result checks, and [protocols/cohere.ts](protocols/cohere.ts) for the HTTP format.

```sh
pnpm --filter @ema-agent/rerank test
```

Tests replace `fetch` to check scores, tie ordering, duplicate-index rejection, empty candidates, and a single failed request without automatic retry.
