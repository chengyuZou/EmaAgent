# Windows computer-use executable

[中文](README-zh.md)

`ema-computer-use.exe` is a private companion process for EmaAgent's local Server. It exposes newline-delimited JSON-RPC over its inherited pipes, without a listening network port. The Node package owns Session coordination; this process owns Windows interaction and the desktop overlay.

## Windows implementation

- `windows/capture.rs` captures a window or the primary monitor with Windows.Graphics.Capture and D3D11, then encodes PNG. Cursor pixels are excluded.
- `windows/accessibility.rs` reads a bounded UI Automation control view and keeps native element references on the worker thread. Missing accessibility support returns an incomplete list and retains screenshot access.
- `windows/observation.rs` binds an observation to a control, window, image geometry, controls, and a revision. User intervention and scrolling invalidate old observations. Each action also consumes its observation.
- `windows/input.rs` activates and validates the target before input. It provides mouse actions, bounded drag, Unicode typing, key chords, and available UI Automation actions. Input effects can be partial; an interrupted operation is never replayed automatically.
- `windows/inputMonitor.rs` observes real desktop left, right, and middle mouse-button presses and keyboard input. Own injected events are marked and do not pause control. Moving the mouse or turning the wheel does not pause control, but scrolling invalidates observations. The hooks run on their own thread, so screenshots, input, and overlay drawing never delay keyboard or mouse handling.
- `windows/overlay.rs` owns a no-activation, topmost layered window. It draws a fixed blue panel with white text and blue glow. The title and control row are centered independently. Pause shows a continue button followed by its shortcut, then an end button followed by Esc help. Running shows Esc help followed by the end button. Each state and DPI is drawn once per control and reused until the control ends.

Ctrl+Alt+C and the continue button request resume after held trigger keys/buttons are released and any active action has unwound. Esc and the end button terminate control. The chat Turn is not cancelled. The overlay requests exclusion from screen capture; screenshot behavior still needs checking on the target Windows environment.

The pipe reader, the overlay message loop, and the input hooks each run on their own thread and remain responsive while the worker executes screenshot, accessibility, or input requests. Ending a control refuses new input immediately, waits for active work to unwind, then answers end requests. EOF stops input and closes the overlay. The executable does not restore a previous control after restart.

## Build and verification

From the repository root:

```sh
node apps/desktop/scripts/buildComputerUse.mjs
cargo test --locked --manifest-path apps/computer-use/Cargo.toml
```

The build script copies the executable to `src/computer-use/bin/` for development and packaging. `pnpm dev:start` runs it before Tauri development. `pnpm release` builds a release executable before assembling Server resources. Other platforms keep their existing screenshot path and do not expose Windows control.

The real desktop test is explicit because it opens its own temporary editing window and sends input only there:

```sh
cargo test --locked --manifest-path apps/computer-use/Cargo.toml native_desktop_round_trip -- --ignored --nocapture
```

It checks real window capture, UI Automation, Unicode input, pause invalidation, and refusal after end. It does not write user files. Physical keyboard/mouse interruption, mixed DPI, multiple monitors, secure desktops, and third-party applications require desktop acceptance beyond this fixture.
