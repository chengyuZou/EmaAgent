# Why the input queue schedules conversation execution

[中文](README-zh.md) | [Documentation](../../README.md)

Clicking Send is only one way a Session receives new input. Subagents and background commands finish, Goals may need to continue, and the user may add requirements during execution or manual compaction. We want a consistent delivery order without requiring the user to wait for an idle Session before submitting input.

## Why idle input also enters the queue

For a single user message, starting a Turn immediately is straightforward. With several producers starting work independently, each must decide whether the Session is busy, which work should run now, and where input belongs if startup fails. Inputs arriving close together can each appear to require a new Turn.

We chose one delivery arrangement, including ordinary sends to an idle Session. The queue decides when to deliver content; the Turn executes the work for that run. Each producer does not have to repeat the same startup decisions.

The cost is queued state and the UI feedback it needs. A successful send does not establish that the model has read the input or that the message has been formally saved. Nor does each queued item necessarily start its own Turn: several waiting user inputs can be delivered together.

## Why queued input and immediate guidance are different

The user may be arranging the next task or correcting the current one. Delivering every new input immediately can mix the next task into unfinished work. Holding everything for the next Turn can delay a correction too long.

Ordinary queued input therefore waits for a later Turn, while the user can explicitly request immediate guidance. Guidance is delivered after the current complete batch of tool calls has been handled, without forcibly interrupting an already executing tool action.

We accept that guidance cannot take effect instantly. A new instruction does not automatically undo a click, command, or write already performed. The delivery state needs to be visible rather than imply that clicking guidance changed a model request already in progress.

## Why claiming input is not saving it

Input can be selected for a Turn before model preparation or message saving succeeds. Treating that claim as formal history and deleting the queued input could lose content that has not been handled.

We confirm consumption after the message is saved. On failure or stopping, unsaved user input returns to the draft; saved messages remain in history. This also avoids automatic retries that could repeat paid requests or operations.

The UI therefore needs to distinguish waiting, claimed, and saved content. Already claimed input cannot always be removed or guided again, and a rejected action needs an explanation. We accept that state complexity to preserve the actual disposition of the input.

## Limits we currently accept

The queue exists in process memory and does not automatically recover after an application restart. We have not turned every pending notice and draft into another persistent task system. Unsaved input consequently cannot be treated as durable history.

Usage and detailed ordering are in the [Turn module](../../../src/turn/README.md). If users need reliable restart recovery, revisit how undelivered input is saved, cancelled, and replayed.
