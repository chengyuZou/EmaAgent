# Why the general-purpose knowledge base was removed

[中文](README-zh.md) | [Documentation](../../README.md)

We removed the general-purpose knowledge-base feature. EmaAgent is a local Agent that can already read supplied files, let the model choose search terms, use rg on searchable text, and read further to extract what it needs.

## Why we start with existing file tools

For current code-search needs, we favor direct, fast text search. The user already has the original files and the Agent can access them. We do not want to add RAG simply to follow a trend and maintain another import, chunking, vector-indexing, and update workflow.

We chose to use file reading and search for actual tasks first. When a document changes, the Agent can read the current file without requiring the user to synchronize another copy into a separate knowledge base. This is a scope choice for EmaAgent today, rather than treating a general KB as a required configuration feature.

## Limits we accept

Text matching can miss synonyms, and the model may need several searches and reads. File format and whether searchable text is available also affect what the Agent can do. We accept those limits without treating the speed of one rg match as a guarantee of total task latency or complete retrieval.

If users identify a concrete need that existing reading and search cannot meet, we will reassess KB for that problem. We are not retaining the whole feature for hypothetical demand.

Reading and search entry points are in [Built-in tools](../../../src/builtin-tools/README.md). Narrative has its own fixed story scope and retrieval tradeoffs, described in the [story retrieval design](../narrative/README.md).
