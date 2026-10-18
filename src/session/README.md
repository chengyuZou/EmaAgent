# Session

[中文](./README-zh.md)

Session manages conversations, projects, message history and the current running-work registration. `SessionStore` applies business rules using Storage repositories; `SessionRunningRegistry` holds in-process Turn/compaction identities and cancellation signals.

## Conversations and projects

Create a store with a data `Database`, optional change/file-cleanup callbacks and `isWorkClosed` supplied by the running registry. `createSession` chooses cwd once: explicit input, then the project's primary folder, then `~/.ema-agent/workspace`. The fallback is created if needed. Project membership and later folder changes do not rewrite existing Session cwd.

Provider/model selection is stored as a pair; reasoning `off` explicitly disables reasoning. Permission mode and TTS selection affect subsequent Turns. Changing permission to Plan checks for an unfinished Goal in the same SQL transaction; a conflict leaves every field unchanged.

Sidebar queries return unarchived conversations in pinned Sessions, pinned projects, other projects and recents. Pinned project members appear only in the pinned bucket. `moveSessionInSidebar` changes membership, pinning and insertion position together; moving into pinned clears project membership. List/search items derive running, latest-Turn and unread fields from database facts. Plain `getSession` returns only the Session itself.

`updateTitleIfDefault` conditionally replaces the default title in SQL, so automatic naming cannot overwrite a saved user title. Archived conversations have a separate metadata list. `getSessionForWork` rejects archived/stopping Sessions; history reads and final message writes remain available.

## Messages and summaries

`appendMessage` checks Turn ownership, serializes blocks and emits a message-change event after insertion. It does not generate titles. `updateMessageBlocks` replaces the stored blocks under the same Message ID without sending an event for every delta.

Stored user messages can contain text/media, tool results, `image_reference`, `pasted_text_reference`, `file_reference` and `skill_reference`. Assistant messages preserve native block order. `parseMessageBlocksJson` checks database JSON by role and returns a readable placeholder for invalid content. [Context](../context/README.md) converts stored references into model input.

`appendHistorySummary` requires a last-covered Message ID from the same Session and saves the reduction estimate with the summary. Automatic summaries use the current Turn ID; manual summaries use null. Original messages remain stored.

```text
Stored:       covered A, covered B, retained C, summary S, later D
S covers:     through B
loadHistory:  S, C, D
```

The summary's insertion time is not its coverage boundary. `loadHistory` returns the latest summary and newer uncovered messages in model order, limited to 500 messages by default. UI queries use `listMessages` or `listMessagesAround` instead: pages are always chronological, with opaque createdAt/ID cursors. Default page size is 50, maximum 200; an around-window defaults to 20 before and 30 after, with at most 100 surrounding messages.

## Fork and deletion

`forkSession` copies all history or history through an inclusive Turn, remapping Turn, Message and summary-cursor IDs in one transaction. Managed attachment paths still reference source files rather than independent copies. Deleting the source can therefore make those attachments unreadable in the fork.

The Server coordinates stopping work before deletion. `deleteSession` deletes database rows, then invokes file cleanup, and emits the list change even if cleanup fails. `deleteArchivedSessions` deletes the archived set in one transaction and returns actual IDs. The Server then handles files/caches and one batch event; a file-cleanup failure does not roll SQL back. See [sessionActions.ts](../../apps/server/src/application/sessionActions.ts).

## Running-work registration

Register either `{ kind: 'turn', turnId }` or `{ kind: 'compact', compactId }`. Abort and clear require the same identity, so a late request cannot affect newer work. Abort only signals cancellation; the execution owner must finish saving and call `clear`. `waitUntilIdle` waits for that removal.

`runWithSessionClosed` immediately blocks new work for one Session and aborts its current registration. Overlapping actions keep it closed until all finish. `runWithRegistrationsClosed` blocks registrations globally and serializes its callbacks, used for character changes. These registrations are process state, not persisted history.

## Notifications and checks

| Event | Consumer action |
| --- | --- |
| `session_list_changed` with Session ID | Refresh that Session's metadata/list entry. |
| Same event without ID | Refresh project/grouped lists. |
| `session_messages_changed` | Read newly stored messages for the Session. |
| `sessions_deleted` | Remove the listed IDs and refresh affected lists. |

Start with [store.ts](./store.ts), then the specific Storage query. [sessionRunningRegistry.ts](./sessionRunningRegistry.ts) explains cancellation and cleanup ordering. Tests use SQLite for history, ownership, summary boundaries, sidebar rules and preferences, plus isolated registry tests.

```sh
pnpm --filter @ema-agent/session test
```
