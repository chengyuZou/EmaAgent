# Agent

[中文](./README-zh.md)

Agent runs the model/tool loop used by Turn and subagents. The host supplies model calls, per-iteration request preparation, tool executors and optional messages to add between iterations. Subagent execution also stores stable identities, individual Runs and their messages.

## Loop and persistence order

`runAgentLoop(input)` is an async generator. For each iteration it calls `prepareIteration`, adopts the returned working history, creates a tool executor and consumes `CallLLM` events.

The consumer must finish saving a yielded event before requesting the next one:

```mermaid
sequenceDiagram
  participant Loop as AgentLoop
  participant Host as Turn or SubagentExecutor
  participant Tools as StreamingToolExecutor
  Loop-->>Host: tool_use_completed
  Host->>Host: Save the complete tool call
  Host->>Loop: Resume generator
  Loop->>Tools: addTool
  Loop-->>Host: assistant_message_completed
  Host->>Host: Save complete assistant blocks
  Loop-->>Host: tool_result
  Host->>Host: Save result
  Host->>Loop: Resume generator
  Loop->>Tools: acknowledgeResult
  Loop-->>Host: model_history_appended
```

Tools can start while the model is still streaming, after their complete arguments have been saved. Each result occupies its own user message in working history. Reasoning blocks retain native state and generation source for adapter replay decisions. An executor notification wakes the loop when results or user-wait state change.

After complete assistant/tool history, `takeNextIterationMessages` can supply additional input. It is checked even after a reply with no tools. New messages start another iteration without interrupting the current model response or splitting tool pairs. If the generator exits early, it shuts down unfinished tools.

## Recovery and limits

- A context-window error before any response event permits one retry within the same iteration. The host receives `recoveryReason: 'context_window_exceeded'` and decides whether to compact.
- A tool-free `max_tokens` response keeps its text and adds a continuation message. If the continuation also truncates, the loop stops with `output_recovery_failed`.
- Three consecutive identical tool batches add one reminder to change approach. Equality uses sorted tool names plus serialized arguments.
- At `maxIterations`, the loop stops with `max_iterations`; the host decides the Turn outcome.

Every physical model call has a new `llmCallId`. Per-call usage events are cumulative for that call; Agent usage sums their changes. A context retry is a new physical call, not a new iteration. Other model errors propagate to the host.

Settings default to 50 iterations per loop and 32 concurrent subagents per process, with allowed ranges 30-100 and 1-128. All Sessions share the subagent limit. Reaching it rejects a new Run rather than queueing it. The host reads and applies these settings.

## Subagents

`SubagentExecutor.start` returns `{ subagentId, runId }`. An identity belongs to a Session and keeps the most recently prepared configuration. Each Run has its own configuration, result, usage and terminal state. Continuing an identity creates a new Run; it does not overwrite earlier Runs.

The host's `PrepareSubagent` chooses model, context, Prompt and tools. New requests can use an independent history or a fixed fork prefix; continued identities use their own history. Fork initialization creates new Message IDs, preserves inherited assistant generation sources and supplies placeholders for parent tool calls. New subagent output derives its source from its Run.

Foreground execution follows the parent Turn's abort signal. Moving to background detaches that signal without restarting execution. Only one result owner is active:

| Owner | Delivery |
| --- | --- |
| `subagent_call` | Initial tool call waits for its own result. |
| `subagent_await` | A later SubagentAwait waits for the running result. |
| `session_notification` | Completion notifies the Session queue; the model can query the stored result. |

Cancelling an await ends that wait, not the background execution. Explicit Session/Turn removal and shutdown have separate cancellation entries. Terminal results are stored before terminal events or background completion notifications. `onRunFinished(runId)` lets the host clear pending approvals for that Run. Recovery marks leftover running Runs failed; it does not restart them.

`SubagentMessagesStore` saves streaming and completed blocks under the same Message ID. Its history-ID array follows `model_history_appended`, so compaction can map its covered prefix to a real SQL cursor. Message updates contain stored content; terminal events contain the specific completed Run, not an assumed current identity state.

## Reading and checking

Start with [agentLoop.ts](./agentLoop.ts) for the generator contract, then [subagentExecutor.ts](./subagentExecutor.ts) for result ownership. `subagents/` contains SQL-backed identity/Run and message stores. Real consumers include [Turn](../turn/turn.ts), [Turn subagent preparation](../turn/prepare/prepareSubagent.ts) and [Server composition](../../apps/server/src/composition/turn.ts).

`pnpm --filter @ema-agent/agent test` checks event ordering, retries, native reasoning, cancellation, fork histories, multiple Runs and SQLite persistence. Tests use controlled model/executor replacements rather than paid API calls.
