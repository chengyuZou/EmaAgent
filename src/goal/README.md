# Goal

[中文](README-zh.md)

`@ema-agent/goal` stores a Session's ongoing objective, latest progress note, and final outcome. `GoalStore` applies the state and version rules before writing through Storage.

## Use

```ts
const goals = new GoalStore(dataDb, emit, isSessionWorkClosed);
const goal = goals.create(sessionId, 'Prepare the release');
const reported = goals.reportFeedback({
  sessionId,
  goalId: goal.id,
  expectedVersion: goal.version,
}, 'Build and tests passed, installer verification remains.');

const current = goals.getCurrent(sessionId);
```

The third constructor argument is an optional callback used to reject creation or activation while the Session is stopping. Server provides its Session-running registry check. `getCurrent` returns an active or paused Goal, or `null`. `get(sessionId, goalId)` reads one full record. `listSummaries(sessionId)` returns history ordered by creation time and ID, newest first; feedback, error details, and the mutation version are read through `get`.

## State and edits

| Operation | Allowed state | Result |
| --- | --- | --- |
| `create` | No active or paused Goal in the Session. | New `active` Goal, version 1. |
| `edit` | `active` or `paused`. | Preserves objective whitespace and clears previous feedback. |
| `reportFeedback` | `active`. | Replaces the latest progress note. |
| `pause` / `activate` | `active` or `paused`. | Switches between the two unfinished states. |
| `complete` / `fail` | `active`. | `completed`, with reason `succeeded` or `failed`, and a fresh feedback note. |
| `cancel` | `active` or `paused`. | `completed`, with reason `cancelled`, retaining feedback. |
| `delete` | Any existing state. | Physically removes that Goal. |

Only final failure stores `error`. Completed Goals remain readable but cannot be edited or activated. Each Session has at most one active or paused Goal, enforced by SQL. Creation and activation reject missing, archived, stopping, or Plan-mode Sessions. Session permission changes enforce the other side of the Plan/Goal conflict.

Every mutation and deletion supplies `GoalIdentity`: `sessionId`, `goalId`, and `expectedVersion`. The read, version check, state check, and write share one synchronous SQLite transaction. A changed record increments its version; an identical edit, feedback report, or state request does not write or emit another event, but still requires the current version. A conflict never applies an old request to a replacement Goal.

`GoalError.code` identifies the rejection. Its `current` value contains the record read for a conflict, or the current unfinished Goal when the requested ID is missing. Callers must reassess current facts rather than automatically retrying an old completion decision with a new version.

## Events and application flow

```text
HTTP / Goal tool / startup recovery
    -> GoalStore -> SQLite transaction commits
        -> GoalEvent -> Server application events
            -> UI refresh and continuation queue
```

Changes emit the corresponding event with the full Goal. `goal_deleted` carries only `sessionId` and `goalId`. `goal_edited` means the objective changed; `goal_updated` means feedback changed. These are distinct inputs for the continuation queue.

Before Server reports ready, `pauseActiveOnStartup()` changes persisted active Goals to paused, increments their versions, and emits events after the transaction commits. It preserves IDs and progress instead of automatically resuming work after a restart.

User actions enter through the [Goal route](../../apps/server/src/routes/goals.ts) and the [chat send route](../../apps/server/src/routes/ws/session.ts). Model progress and final outcomes enter through [GoalUpdate](../builtin-tools/tools/GoalUpdateTool/GoalUpdateTool.ts). The [continuation queue](../turn/sessionContinuationQueue.ts) decides when an active Goal should produce another Turn. Pausing a Goal stops future continuation; it does not itself abort the current Turn.

There is currently no overall Goal Token budget or cross-Turn idle-stop rule. The remaining work is recorded beside the affected implementations.

## Verify

Read [goalStore.ts](goalStore.ts) for state changes and [types.ts](types.ts) for identity and result fields. [Storage's Goal repository](../storage/repos/data/goals.ts) contains the SQL operations.

```sh
pnpm --filter @ema-agent/goal test
pnpm --filter @ema-agent/goal typecheck
```

Tests use real SQLite records to check state changes, stale writes, post-commit events, restart recovery, and Session deletion.
