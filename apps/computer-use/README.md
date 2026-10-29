# Native computer use

[中文](README-zh.md)

The Windows helper provides window discovery, window and display capture, UI Automation, keyboard/mouse input, and the control overlay. Node owns Turn identity and startup approval. The helper receives requests over stdin and writes JSON-RPC replies/events to stdout.

Input hooks, request execution, pipe reading, and overlay rendering run separately. Physical Esc ends control. Physical keyboard input, button presses and wheel events in the target window invalidate its observation without changing control state. Injected input is excluded. Each action checks its observation revision, target identity and position; interrupted input releases held keys/buttons and reports whether effects are possible.

Observe attempts to restore/activate the selected window. Activation failure is reported separately from image capture. Input requires activation and checks keyboard focus or the target point before submission. Every completed action consumes its observation.

The fixed blue overlay has white text and an end button. Four static corner glows follow the foreground monitor. Glow windows are click-through. Images are reused at the same DPI; position and topmost order are maintained without taking focus. This cannot guarantee priority over secure desktops or every competing topmost window. Overlay windows request capture exclusion.

Ending rejects new input, waits for active work to unwind, then sends ended and replies to end requests. Closing stdin also ends control and closes native UI. A new process does not restore old control.

## Build and verify

Run from the repository root:

```sh
node apps/desktop/scripts/buildComputerUse.mjs
cargo test --locked --manifest-path apps/computer-use/Cargo.toml
cargo test --locked --manifest-path apps/computer-use/Cargo.toml native_desktop_round_trip -- --ignored --nocapture
```

The ignored test creates its own temporary editor window and exercises capture, accessibility, text input, observation invalidation and termination. It does not write user files. Real input hooks, DPI changes, topmost applications and multiple displays also need manual acceptance. Windows binaries embed assets/icons/icon.ico. Other platforms retain their existing capture paths.
