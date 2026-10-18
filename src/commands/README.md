# Commands

[中文](./README-zh.md)

This package provides the chat command catalog and manual Session compaction. The catalog contains `compact` and `goal`. The desktop opens the Goal editor itself; manual compaction calls `compactSession(deps, sessionId)` through the Session WebSocket.

## Manual compaction

The Server supplies Session storage, the running-work registry, model settings, current character and Skill sources, image handling, and a `CompleteLLM` factory. See [Server composition](../../apps/server/src/composition/commands.ts) for the wiring.

1. Check that the Session accepts work and has a selected model, then register cancellable compaction under a generated `compactId`.
2. Load effective history and use [Context](../context/README.md) to convert it into model messages. Historical replies retain their speaker and model source.
3. Check history alone against `context.compact.manualMinRatio`. Reject short history before loading Skills and Memory guidance. Also reject history entirely within the recent-text retention budget.
4. Assemble the current static and dynamic System Prompt. Call [Compact](../compact/README.md) with `force: true`, `micro: false`, and no tools.
5. Map the summarized message count to the last covered SQL Message ID. Append the summary with `turnId: null`; original messages stay in storage. Compact emits completion after saving.
6. Clear the running registration before notifying the continuation scheduler through `onFinished`.

The result is `completed`, with context window, before/after estimates, saved tokens and duration, or `cancelled`. Other failures throw `CommandsError` or dependency errors. Cancellation uses the registered `compactId`; manual compaction does not create a Turn.

`GET /api/commands` returns the catalog. The desktop sends `start_compaction` over the Session WebSocket and receives `manual_compact_result`. See the [WebSocket route](../../apps/server/src/routes/ws/session.ts) and [input menu](../../apps/desktop/src/chat/input/AddInputMenu.tsx).

## Reading and checking

Start with [compactSession.ts](./compact/compactSession.ts), then follow Context projection and the Compact save callback. [catalog.ts](./catalog.ts) contains menu entries. Server request/error handling is covered in [sessionWebSocketRoute.test.ts](../../apps/server/tests/sessionWebSocketRoute.test.ts). This package currently has no local test files.
