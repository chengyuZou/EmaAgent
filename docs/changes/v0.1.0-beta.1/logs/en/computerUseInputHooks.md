# Computer-use input hooks shared a thread with overlay drawing

[中文](../zh/computerUseInputHooks.md)

## Status

Source changes were completed on 2026-10-28. The build, the default tests and the real desktop test `native_desktop_round_trip` passed. Physical keyboard and mouse takeover, mixed DPI and installed-build acceptance remain unverified.

## Risk and basis

This risk was found while reading the code. No actual input delay was observed.

`ema-computer-use.exe` uses Windows low-level keyboard and mouse hooks to detect when the user takes over. A low-level hook callback is invoked through the message loop of the thread that installed it, and system keyboard and mouse input waits until the callback returns. The previous implementation installed the hooks on the overlay window's thread. Each overlay state change computed the rounded panel and glow pixel by pixel before drawing text.

Based on the sizes in the code, the paused overlay is about 445x128 pixels at 100% scaling and about 230,000 pixels at 200% scaling. Each draw is estimated to take a few milliseconds to a little over ten milliseconds; this was not measured. Drawing happens only when control starts, pauses, resumes or ends, or when DPI changes, which is not enough to cause a noticeable delay today. A continuous animation or a larger overlay would slow hook handling accordingly, and Windows can skip or even remove a hook whose callback times out.

## Change

- [inputMonitor.rs](../../../../../apps/computer-use/src/windows/inputMonitor.rs) adds a dedicated `computer-use-input` thread. It only installs the hooks and runs a message loop without a window. At startup it creates the thread message queue first; when it receives the thread quit message, it removes the hooks.
- [overlay.rs](../../../../../apps/computer-use/src/windows/overlay.rs) no longer installs hooks. Drawing is split into image generation and display. The image and button bounds are cached by pause state, whether the resume shortcut was registered, and DPI. The position is still computed on every display from the monitor of the foreground window. The cache is cleared when control ends and the overlay is hidden.
- [mod.rs](../../../../../apps/computer-use/src/windows/mod.rs) starts the overlay thread and then the input-hook thread, closing the overlay if the hook thread fails to start. On exit, `close_desktop_ui` stops both threads.

The hook callbacks already only updated shared state and posted redraw messages, so the split adds no new data transfer between threads. The protocol, state notifications and action results are unchanged.

## Verification

The checks used the local `cargo test` debug build on Windows 11 22621.

- `cargo build` and `cargo test` passed without compiler warnings. The default suite contains only one ignored desktop test.
- `native_desktop_round_trip` passed on an interactive desktop in about 1.2 seconds. The test operates only on its own temporary editing window and covers startup of both threads, window capture, UI Automation, Chinese text input, observation invalidation after pause, refusal after end, and process exit.
- The test exported the overlay images for the running and paused states. Titles, buttons, hint text, the blue panel and the glow match the README description. Returning from pause to running in the test used the cached image; cache hits do not export images, so that frame was not checked separately.

## Not yet verified

- The test calls pause directly without going through the hooks. Physical mouse clicks, key presses, wheel movement and Esc need to be confirmed on a real desktop with the new thread.
- The continue and end buttons on the overlay, and resuming with Ctrl+Alt+C.
- Redrawing when the foreground window moves between monitors with different scaling.
- Installed-build acceptance.
