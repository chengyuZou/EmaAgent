# Why Complete collects a stream internally

[中文](README-zh.md) | [Documentation](../../README.md)

Summary generation and keyword extraction can await a complete result without showing incremental output. That preference does not require non-streaming transport underneath.

## Why we did not keep native non-streaming requests

Manual compaction encountered this actual error:

```text
Streaming is required for operations that may take longer than 10 minutes.
```

The completion call used non-streaming transport. The Anthropic SDK checks whether a non-streaming request is allowed using conditions such as its output budget, and can reject it before sending HTTP. This message does not establish that the model has already run for ten minutes, that the network is slow, or that the summary content is wrong.

Keeping native non-streaming calls would leave each complete-result consumer dealing with this transport restriction. Simply reducing the output budget could also restrict the result the task needs.

We retained the awaitable result interface and chose to collect a CallLLM stream inside Complete before returning. The primary reason was the request restriction encountered in practice, not an assumption that collecting streams is inherently faster.

## Why callers do not supply CallLLM

The Complete factory creates CallLLM internally. Callers supply the connection, model, and request. Invoking Complete makes one model request; it does not request a stream and then make another request for a complete result.

Summary and extraction consumers need not implement delta assembly, block ordering, usage collection, or stream closure. Request conversion and stream-event handling also need not be maintained again for native non-streaming responses.

Each request owns its stream and collected content, while the factory can reuse its SDK client. The implementation handles those lifetimes without making each consumer manage another CallLLM function.

## Costs and limits we accept

A complete result must be collected in memory. The caller still receives it only after collection finishes. Streaming transport does not make that business result finish earlier or inherently reduce memory use.

Streaming requests can still time out, disconnect, hit rate limits, or be cancelled. Failures do not become successful completions, and no extra model request is automatically sent to fill a gap. On a normal output-limit stop, callers must still inspect the stop reason before using the result. A complete response does not establish that the entire task was answered.

The choice separates transport from result consumption. Conversion and error contracts are in [LLM](../../../src/llm/README.md); the factory is in [languageModel.ts](../../../src/llm/languageModel.ts).
