# Narrative

[中文](./README-zh.md)

This package retrieves original story passages from the three fixed timelines of Magical Girl Witch Trials. One LLM call identifies the timelines that may be relevant to the user's question, generates subquestions for those timelines, and extracts keywords. Retrieval finds source passages, then Rerank orders them against the original question. The result is evidence for the main Agent, not a generated answer.

## Use

The host opens the Narrative database, creates its Storage repositories, and provides three model-call functions:

```ts
const search = new NarrativeSearch(chunksRepo, graphRepo);
const result = await search.search(
  query,
  'hybrid',
  completeLLM,
  callEmbed,
  callRerank,
  signal,
);
for (const [timeline, value] of result) {
  if ('text' in value) {
    useEvidence(timeline, value.text);
  } else {
    showFailure(timeline, value.message);
  }
}
```

All three call functions are required. The result is a Map in routing order, containing only the selected timelines: 1st_Loop, 2nd_Loop, and/or 3rd_Loop. A successful value has text; an empty string means no usable evidence. A failed timeline has message.

Embedding must use the asset's original Pro/BAAI/bge-m3 vector space. The package checks for 1024 dimensions, but another 1024-dimensional model is not interchangeable. Stored vectors are little-endian Float32 values. The host owns provider configuration and usage records.

## Query flow

```mermaid
sequenceDiagram
    participant Host as Server / NarrativeSearchTool
    participant Search as NarrativeSearch.search
    participant LLM as CompleteLLM
    participant Embed as CallEmbed
    participant DB as Narrative Storage repositories
    participant Rank as CallRerank
    Host->>Search: Query, mode, calls, signal
    Search->>LLM: Route timelines and extract keywords
    LLM-->>Search: Per-timeline subquestions and keywords
    Search->>Embed: One batch of distinct required texts
    Embed-->>Search: Query and keyword vectors
    loop Each selected timeline
        Search->>DB: Find graph candidates and source passages
        Search->>Rank: Original query and at most 20 complete passages
        Rank-->>Search: Passage indexes in ranked order
    end
    Search-->>Host: Map of evidence or per-timeline errors
```

Routing follows the user's explicit timeline first. A final-outcome question with no earlier scope targets the third loop; comparisons select the needed loops. The fixed summary helps locate events and resolve names. It is not returned as evidence and must not prefill an answer into the subquestion.

High-level keywords search relationships and themes; low-level keywords search named entities and objects. Theme phrases use English; proper names retain the question's language. Each keyword group may be empty. Required embedding texts are deduplicated across routes and encoded in one batch.

| Mode | Retrieval |
| --- | --- |
| local | Match low-level keywords to entities, then read their incident relations |
| global | Match high-level keywords to relations, then read their endpoint entities |
| hybrid | Alternate and deduplicate local and global results |
| naive | Search passage vectors with the routed subquestion |
| mix | Combine hybrid results and direct passage search |

Local or global can use the other side when its own keywords are absent. With both groups empty, local, global, hybrid, and mix return empty evidence; naive still searches passages.

Entity and relation searches each start with up to 40 vector candidates. These searches and direct passage search use cosine similarity with a 0.2 threshold. Graph source passages are ranked within the already selected source groups without that threshold. Entity and relation descriptions are limited before loading source passages; the descriptions themselves are not returned as evidence.

Source selection groups passages by entity or relation, deduplicates references, and uses the subquestion vector to select candidates. Entity-source passages are selected first; relation-source selection excludes them. Where no usable source vectors exist, earlier groups receive larger allocations. Python-style rounding preserves LightRAG's allocation behavior.

Each timeline sends at most 20 complete passages to Rerank with the original search question, not the extracted keywords. Up to 8 ranked passages are returned per timeline. Scores from separate timeline requests are not compared.

## Evidence budget, failures, and cancellation

The whole search has a 32,000 UTF-16-code-unit budget, divided equally among selected timelines. JSON escaping and newlines count. Output keeps a prefix of complete passages in ranked order and stops at the first passage that does not fit. Each line is a JSON object with chunk_id and content; its timeline is the Map key.

An empty question, routing request failure, invalid routing JSON, or unknown timeline fails the whole search. Routing text may have thinking tags removed and JSON repaired, but its fields still pass the schema. No substitute keywords are invented after a routing failure.

A batch Embedding failure becomes an error for each timeline that needed embeddings. A local retrieval or Rerank failure affects its own timeline, leaving other timelines' results available. A failure does not return unranked results as if ranking had succeeded. No candidates means no Rerank call.

The same signal reaches all model calls. Cancellation is thrown to the caller rather than returned as a timeline error. Timeline tasks yield once before local retrieval, then may await Rerank concurrently. SQLite and vector calculations run on the same thread, not in workers; new cancellation events cannot run during a synchronous calculation.

## Host integration and data

Server composition in `apps/server/src/composition/narrative.ts` resolves narrative-llm, narrative-embed, and narrative-rerank bindings at Turn preparation. It records each model call's final usage with the initiating Session and Turn. Configuration changes affect the next Turn. An auto query-mode setting uses the tool's mode or hybrid; a fixed setting overrides the tool's choice.

The routing/keyword LLM request uses native non-streaming completion with `maxOutputTokens: 8192`, independently of the model catalog's maximum output capacity. This is a request budget, not the evidence-text budget above. Reaching the output limit fails the routing request rather than parsing a truncated result. Anthropic's SDK can reject excessively large non-streaming output budgets before sending HTTP; raising its timeout or switching this search to streaming is not required by this wiring.

Turn preparation supplies the search function only when the current character's name matches `isWitchTrialCharacter` and model configuration is available. The name check uses a fixed list of complete Chinese, Japanese, and English names, trims whitespace, and ignores English case. It does not change the user's tool toggles. Browser code imports the separate `@ema-agent/narrative/isWitchTrialCharacter` entry to avoid loading Node retrieval code.

That entry also exports `witchTrialCharacterNames`, the same grouped names used by the predicate. Each group starts with the Chinese full name, followed by accepted alternate full names. The character settings table renders these groups directly instead of maintaining a second list.

`NarrativeSearchTool` converts the Map into arrays for tool-result persistence and transport, derives found/partial/empty/unavailable, and exposes evidence and failure text to the model and UI.

Storage owns the fixed chunks, entities, relations, their source links, and vectors. Graph-only modes read candidate source vectors; naive and mix search all passage vectors for their timeline. Mix reuses that read for source selection. Passage text is loaded after candidate IDs are merged. Vectors and intermediate results are not retained between searches.

## Reading and verification

Read `pipeline/recall.ts` for the full flow, `router.ts` and `prompts.ts` for routing, `query.ts` for mode selection, and `retrieval/sourceChunks.ts` for source selection. `vectors.ts` ranks vectors; `context.ts` enforces whole-passage budgets.

Run `pnpm --filter @ema-agent/narrative test` and `pnpm --filter @ema-agent/narrative typecheck`. Tests use real in-memory SQLite tables and repositories with simulated model responses. They cover routing-call count, embedding deduplication, five modes, ranking inputs and order, budgets, partial failures, and cancellation. Tool conversion is tested in `src/builtin-tools/tests/NarrativeSearchTool.test.ts`. These tests do not validate live model routing or the factual accuracy of the fixed summary.

Retrieval and keyword classification follow LightRAG 1.4.16. Its MIT license is preserved in [LICENSE.lightrag](./LICENSE.lightrag).
