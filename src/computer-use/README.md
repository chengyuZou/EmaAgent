# Computer use

[中文](README-zh.md)

This package connects Node Server to the bundled Windows helper. One shared ComputerUse owns desktop control for one Session and one Turn. The first observation's ToolCallId becomes controlId. It stays stable across Loops, but every Turn outcome closes its control before publishing the terminal result.

## Calls and approval

Turn registers the four computer tools with registerCall before scheduling. The returned cleanup removes the call and releases an unapproved startup reservation. ObserveWindow reserves desktop ownership before Permission. Approval starts the helper's control; later actions reuse it. Permission can remember approval for subsequent starts in the same Session. It does not extend control beyond a Turn or approve Shell/MCP tools.

Rust detects physical input in the observed target and invalidates its old observationId. There is no paused state or resume wait. Old actions return without executing, or report possible partial completion if input had already started. The Agent observes again before continuing.

Esc, the overlay end button, and ComputerEnd end computer use without cancelling the Turn. Node cancels queued computer calls; submitted requests return their native outcome. Ordinary tools are unaffected. After user termination, new user text or an AskUser answer permits another startup request; old calls never become valid again. endTurn uses the exact Turn identity so late cleanup cannot close another Turn's control.

## Native connection and capture

NativeComputerProcess uses newline-delimited JSON-RPC over inherited stdin/stdout. Request IDs match replies; computer.stateChanged reports running, ending and ended. The ending state rejects new input while native cleanup releases held keys/buttons. Transport cancellation waits for the native reply, and timeouts do not replay input.

The build copies the executable to bin/. Installed users do not need Rust, Python or a separately installed Node runtime.

capture(signal) returns PNG bytes without starting control. Server supplies it to automatic capture and CaptureTool, which retain their own scheduling and attachment storage. ObserveWindow returns a target image and controls directly. It attempts activation, but a failed activation can still return an image with activationError. ComputerAction checks the target again before input.

See [native implementation](../../apps/computer-use/README.md), [Turn](../turn/README.md) and [tool execution](../tools/README.md). Existing tests use simulated transport; native desktop checks require an interactive Windows desktop.
