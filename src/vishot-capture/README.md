# Screen capture

[中文](README-zh.md)

This package captures one PNG screenshot with the bundled FFmpeg and manages optional automatic screenshots for the current chat. `captureScreen(signal)` returns PNG bytes. `VishotCapture` coordinates automatic capture and tool requests so they share one capture process at a time.

## Automatic capture

Server creates one `VishotCapture` with callbacks for reading settings, checking Session availability and image support, saving images, queueing input and reporting errors. Desktop synchronizes its viewed Session through `PUT /api/vishot-capture/session`, including after Server reconnects. Passing null clears the target.

`setSessionId` restarts the timer only when the target changes. `configure` rereads settings, cancels the previous automatic operation and waits a full interval before the next attempt. Automatic capture defaults to off. `vishotCapture.intervalSeconds` defaults to 30 seconds and accepts integers from 10 through 86,400.

```text
timer -> check idle Session and image support -> capture PNG
    -> recheck -> ImageStore saves attachment
        -> queue atomically checks idle state and accepts image_reference
```

Image support includes either native image input on the Session's configured model or an available Vision binding. Server supplies that check. Busy Sessions, unavailable image handling, or an already running capture cause that timer tick to be skipped.

The queue receives only an image attachment, with no added visible prompt text. Image saving can overlap new user input, so the final idle check and enqueue happen together inside the queue. A refused image is not retried. Saved but unused images remain for attachment residue cleanup.

## Tools, cancellation and shutdown

`capture(signal)` returns bytes even when automatic capture is disabled or no current Session is selected. CaptureTool uses it through Server, which saves the image in the calling Session and binds it to that Turn. Tool permission checks remain in the tool call path.

Automatic and direct captures wait for any existing capture process to finish before starting another. Cancelling FFmpeg requests process termination, but the Promise settles only after the process closes.

Switching Sessions, changing capture settings and closing the service cancel the previous automatic result. Even switching A to B and back to A cannot submit the first A capture. `cancelSession` waits for any automatic image save for that Session to finish before the application deletes its files. `close` cancels work, clears the timer and waits for automatic work and the active capture process.

Automatic failures call `onError` unless cancelled. Server publishes a `system_warning`; later timer ticks may try again. Direct capture failures reject the caller's Promise.

## Platform behavior

| Platform | Capture input |
| --- | --- |
| Windows | gdigrab desktop. |
| macOS | First AVFoundation device listed as Capture screen, not camera device 0. |
| Linux/X11 | x11grab using DISPLAY. |
| Linux/Wayland | Rejected; XWayland is not used as a full-desktop substitute. |

Capture excludes audio and cursor output. FFmpeg comes from `ffmpeg-static`; the code does not search PATH or open a visible terminal. Each FFmpeg invocation has a 15-second timeout. macOS device discovery is a separate invocation before capture. Operating-system screen-recording permission and the required capture device must be available.

## Code and checks

[vishotCapture.ts](vishotCapture.ts) contains timer, cancellation and queue coordination. [captureScreen.ts](captureScreen.ts) selects platform input and manages FFmpeg. [Server composition](../../apps/server/src/composition/vishotCapture.ts) supplies the callbacks, and [CaptureTool](../builtin-tools/tools/CaptureTool/captureTool.ts) requests direct captures.

Run `pnpm --filter @ema-agent/vishot-capture test`. Tests mock processes and time to check platform arguments, cancellation, Session switching, saving races and shared capture ordering. They do not read the actual screen. macOS and Linux/X11 permissions and images still require testing on their respective desktop environments.
