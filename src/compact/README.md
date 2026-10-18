# Compact

[中文](./README-zh.md)

Compact reduces model-visible history so a Session can continue within its model's context window. `createCompact(completeLLM, overrides?)` returns a function accepting `CompactRequest`. Turn uses it before model calls; Commands uses it for manual compaction.

## Input and result

Pass working `messages` without system messages, separate `systemMessages` and `tools`, the model window and optional output limit, and `estimatedInputTokens` for the complete request. System Prompt and tool-definition costs remain in the budget when history changes.

- `unchanged`: original working messages, optionally with a Macro failure detail.
- `micro`: older eligible tool results replaced by short placeholders.
- `macro`: a user message wrapped in `<context-summary>` followed by recent original messages. Includes before/after estimates, saved tokens, duration and `summarizedMessageCount`.

`summarizedMessageCount` counts covered input messages from the start, including an existing summary. It is not a SQL ID. The optional synchronous callback `saveMacroSummary(summary, summarizedMessageCount, savedTokens)` lets the caller map this count to stored history.

## Flow

1. Check the full input against `floor(contextWindow * (1 - bufferRatio))` and the consecutive-failure limit.
2. Unless disabled, Micro clears older successful results from `Read`, `Glob`, `Grep`, `WebFetch` and `WebSearch`. Keep the configured recent eligible results. Return Micro if sufficient.
3. Otherwise Macro selects a recent-text suffix and summarizes everything before it in chronological chunks. Boundaries keep tool calls together with their results.
4. Each model request carries the previous chunk's summary, the next original chunk and summary instructions. Excessive input or truncated output shortens the current chunk for retry, up to three attempts per chunk. Advance only after a usable summary.
5. Check that the complete summary plus suffix fits. Run the optional save callback, then emit `compact_completed` and return Macro.

Micro makes no model call and does not change stored history. A failed Macro chunk returns the original input messages, not a partial summary or Micro replacements. Each model request records its own usage when configured. A save error emits `compact_failed` and rethrows. Cancellation emits `compact_cancelled` and rethrows the abort. SQL storage and running-work registration belong to the caller.

## Settings

| Setting under `context.compact` | Default | Meaning |
| --- | --- | --- |
| `bufferRatio` | `0.15` | Fraction of the model window reserved outside the input budget. |
| `keepRecentToolResults` | `6` | Recent eligible results kept by Micro. |
| `maximumConsecutiveFailures` | `3` | Pause automatic attempts after this many failures for a Session in the same created function. |
| `retainRatio` | `0.16` | Initial recent-original-text budget as a fraction of the model window. More history enters the summary if necessary. |
| `manualMinRatio` | `0.15` | History-only minimum checked by Commands before manual compaction. |

`force` bypasses threshold and failure limits and requires Macro rather than accepting Micro alone. Defaults can be overridden when creating the function; requests may supply their own settings.

Start with [compactMessages.ts](./compactMessages.ts) for decisions, events and saving order. [macroCompact.ts](./macroCompact.ts) contains chunk budgets and tool-pair boundaries; [compactPrompt.ts](./compactPrompt.ts) contains summary instructions. [Turn integration tests](../turn/tests/prepareAgentIteration.test.ts) exercise the real Compact entry point. This package currently has no local test files.
