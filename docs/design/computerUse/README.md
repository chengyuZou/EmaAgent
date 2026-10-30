# Why computer use works this way

[中文](README-zh.md) | [Documentation](../../README.md)

EmaAgent operates the computer the user is already using. The user can still click and type while the Agent works. The design needs to let the user take control back and prevent old actions from running against a screen that has changed.

## Why input no longer pauses control

The pause approach was intended to preserve the task: stop when the user acts, then resume when the user finishes and clicks Continue. That is an intuitive fit for temporarily editing a document.

Real keyboard and mouse input does not always mean the user intends to take over the task, however. The user may be answering another tool's permission prompt. Pausing for that input adds another interaction after the prompt is resolved. It also requires coordinating queued actions, the Turn's wait, and the time at which execution resumes. Clicking Continue cannot establish that the old window, caret, and content are still suitable for those actions.

We therefore chose to invalidate old observations when the user changes the target window, rather than pause control. Old actions that have not executed return without running. Interrupted actions report whether they may have partly completed. The model observes again and decides what to do next, rather than automatically resuming an old action sequence.

This reduces repeated Continue interactions and removes the waits maintained for pause/resume. The accepted cost is that concurrent user activity can invalidate observations repeatedly, require more model requests and screenshots, and slow the task. We accept re-observation instead of treating continued activity as proof that the old screen remains valid.

## Why control lasts for one Turn

Keeping control across Turns can save startup steps. It also leaves an unclear boundary when the conversation appears finished: the user may not know whether the Agent still holds computer control. An overlay left behind after failure or cancellation makes this harder to understand.

We chose a common ending boundary for task execution and control. A completed, failed, or cancelled Turn ends its computer use before reporting its terminal result. A later Turn starts control again if needed. Session approval can reduce repeated permission interactions, while the control itself still ends with the Turn.

## Why ending control does not stop the conversation

The user may want the keyboard and mouse back while still needing a progress report, an explanation of a blocker, or other work. Esc, the overlay End button, and ComputerEnd therefore end computer use alone. Chat's Stop action cancels the entire Turn.

Old queued computer actions cannot become executable when control starts again. Otherwise, the Agent could continue a click or text entry after the user believed control had ended. We accept the possibility of observing and planning again so that ending control has a clear meaning.

## Why only one main Agent can operate

The desktop has one current focus and mouse position. Two Agents can each issue an individually sensible action that, together, enters text into the other Agent's window or clicks the wrong place. We limit simultaneous control to one main Agent and do not let subagents compete for that input.

This limits parallel computer operation but makes it clear who is using the desktop. Conflict between the user and Agent remains possible, and observing again does not guarantee correct model judgment. These choices do not create an isolated automation environment.

Tool usage, native restrictions, and implementation contracts are covered in the [computer-use module](../../../src/computer-use/README.md) and [native program](../../../apps/computer-use/README.md).

