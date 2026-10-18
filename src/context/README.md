# Context

[中文](./README-zh.md)

Context converts stored Session messages into model history and assembles model input from Prompt blocks, working messages and a ToolPool. It also produces the input estimate used for compaction and the context meter.

## Main entries

`projectMessages(history, resolveGenerationSource, attachmentOptions, resolveCharacter?)` returns model messages paired with stored Message IDs. It skips empty content, interrupted assistant replies, and tool calls/results that are missing, repeated or out of order. Reasoning blocks retain signatures and generation source so the LLM adapter can decide whether the target model can replay them. An optional character resolver prefixes normal historical replies with the speaker's name without changing storage.

`assembleContext({ systemPrompt, toolPool, messages, contextWindow })` returns `messages`, `tools` and `usage`:

1. Remove cache markers from working messages; reject system messages mixed into them.
2. Convert nonempty Prompt blocks to system messages in supplied order, preserving their markers. An entirely empty System Prompt is an error.
3. Convert ToolPool entries to LLM definitions in pool order. Explicit JSON Schema overrides take priority over Zod conversion.
4. Mark the last nonempty message for caching and estimate the full input, including System Prompt, history and tools.

The executor uses the same ToolPool. [Turn preparation](../turn/prepare/prepareAgentIteration.ts) assembles input before and after compaction. [Commands](../commands/README.md) uses `buildPromptMessages` for manual summary requests.

## Attachments

`buildAttachmentMessages` handles persisted references:

| Reference | Model content |
| --- | --- |
| `file_reference` | File name and original path; no file read. |
| `pasted_text_reference` | Stored path and saved preview; no file read. |
| Image, model supports images | Label plus base64 image data read from disk. |
| Image, model needs Vision | Label plus a Vision description, using the path-based cache when supplied. |

Idle estimates can pass `imageDescriptionPreview`. This mode reads existing descriptions only. A missing description with Vision available notifies the caller and returns the label without making a model request. Missing configuration, file-read failure and description failure produce explanatory text. Cancellation is rethrown, not presented as a missing image.

Skill references record the user's selection without loading skill instructions. The Skill tool checks the current pool when called.

## Context usage and checking

`estimatedContextUsage` marks a local estimate. `providerContextUsage` uses the Provider's input report and cache counts for that call. `appendEstimatedContextMessages` adds estimates for later messages and changes the source back to `estimate`. These describe context input, not cumulative billed usage or output tokens.

[Attachment tests](./tests/buildAttachmentMessages.test.ts) cover path conversion, image input, Vision cache/preview behavior, failures and cancellation. [Turn tests](../turn/tests/prepareAgentIteration.test.ts) also exercise projection and assembly.

```sh
pnpm --filter @ema-agent/context test
```
