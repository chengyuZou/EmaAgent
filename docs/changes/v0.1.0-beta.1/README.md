# 0.1.0-beta.1

[中文](./README-zh.md)

Status: Draft, not published.

## Narrative adjustments

Experiments informed changes to Narrative query preparation and retrieval parameters:

- Timeline selection and keyword extraction now run as two independent, concurrent requests. Retrieval and Rerank use the incoming query without generating per-timeline subqueries.
- Direct passage-vector retrieval in naive/mix keeps up to 100 candidates. Each selected timeline sends at most 125 merged candidates to Rerank and requests up to 30 results.
- Graph description length no longer excludes associated source passages. Final evidence keeps the existing 32000-character budget, divided among selected timelines.

The limits are defined in Narrative. The shared Rerank interface and its topK parameter remain unchanged. These adjustments do not guarantee complete story evidence.

Module details: [Narrative](../../../src/narrative/README.md). Earlier records: [Alpha](../v0.1.0-alpha.1/README.md).
