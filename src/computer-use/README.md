# Computer use

[中文](README-zh.md)

This package connects the Node Server to the bundled Windows computer-use executable. One shared `ComputerUse` owns the active desktop control. It belongs to a Session and uses the first observation call's ToolCallId as `controlId`. Normal Turn completion does not release it.

## Calls and pause

The main Turn registers computer calls with `registerCall` when they enter the tool queue. The returned function removes the record after completion. Each record holds its control reference and any invalidation reason; it does not implement or forward tool operations.

The first `ObserveWindow` reserves control before Permission. Reservation also binds calls already queued by the same Session, including `ComputerEnd`. Approval starts the native control. Later calls reuse it without repeating Permission; whole-tool deny rules still apply. A refused startup releases the reservation and invalidates the remaining calls from it.

When the user pauses:

- Computer calls that have not submitted a native request immediately return a non-execution result.
- A native action already submitted returns its actual outcome, including possible partial input.
- The main Agent waits before starting other tools or another model request. Existing non-computer operations may finish.
- Resume permits fresh observations and actions. Invalidated calls never become executable again.

The same wait applies when the Session queue starts another Turn. The pause state is independent of whether an old tool or Turn is still running. Subagents do not receive computer tools or the main Agent's pause callbacks.

Esc, the overlay end button and `ComputerEnd` end computer control, not the Turn. Ending invalidates outstanding computer calls, waits for native cleanup and releases main-Agent waiters. Chat stop, Session deletion and application shutdown also clean up control. After user termination, new user text or an AskUser answer allows another startup request; it does not grant Permission or revive old calls.

## Native connection and capture

`NativeComputerProcess` exchanges newline-delimited JSON-RPC through inherited stdin/stdout pipes. Request IDs match replies; `computer.stateChanged` independently reports running, paused, ending and ended states. Cancellation waits for the native reply so partial effects remain visible. A timeout ends the helper without replaying input.

Development and release builds copy the executable into this package's `bin/`. That is the single runtime location. Missing build output produces a startup error. The installed application requires no separate Rust, Python or Node installation.

`capture(signal)` requests PNG bytes without starting computer control. The Server supplies it to [automatic capture](../vishot-capture/README.md) and CaptureTool, which use the existing attachment storage. ObserveWindow returns the window image and controls directly in its tool result without creating a separate attachment file. The [native executable](../../apps/computer-use/README.md) owns Windows capture, input, accessibility and the overlay.

## Integration and checks

[Turn](../turn/README.md) registers computer calls through the execution environment's `onToolRegistered` callback and connects the shared wait through `beforeToolExecution`. The [tools executor](../tools/README.md) only cancels individual queued calls, waits before execution and disposes registrations. It does not interpret computer states. [Builtin tools](../builtin-tools/README.md) call `ComputerUse` directly using ToolCallId.

Run `pnpm --filter @ema-agent/computer-use test`. Tests use a simulated native connection. Tool and Turn integration tests cover startup/end in one batch, immediate pause results, ordinary-tool waits and Session reuse. Desktop interaction still requires native testing.
