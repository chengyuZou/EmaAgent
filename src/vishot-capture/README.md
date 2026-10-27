# Screen capture

[中文](README-zh.md)

This package manages optional automatic screenshots for the current chat and coordinates direct capture requests. The Server supplies Windows capture through the bundled native computer-use executable. `captureScreen(signal)` provides bundled FFmpeg capture for macOS and Linux/X11. Windows requires the native capture entry and does not fall back to FFmpeg.

## Automatic capture

Server creates one `VishotCapture` with `canStartCapture` and `shouldSubmitCapture` callbacks, image capture/storage, queue submission and error reporting. The callbacks combine Session availability, image support and desktop control ownership. Desktop synchronizes its viewed Session through `PUT /api/vishot-capture/session`, including after Server reconnects. Passing null clears the target.

`setSessionId` restarts the timer only when the target changes. `configure` rereads settings, cancels the previous automatic operation and waits a full interval before the next attempt. Automatic capture defaults to off. `vishotCapture.intervalSeconds` defaults to 30 seconds and accepts integers from 10 through 86,400.

```text
timer -> canStartCapture -> capture PNG
    -> shouldSubmitCapture -> compare with last submitted pixels -> save attachment
        -> queue atomically checks idle state and accepts image_reference
```

Image support includes either native image input on the Session's configured model or an available Vision binding. Server supplies that check. Busy Sessions, unavailable image handling, or an already running capture cause that timer tick to be skipped.

Automatic capture also skips a frame whose decoded pixels exactly match the last successfully queued frame. Byte-identical images avoid decoding. Different PNG encoding or metadata does not count as a changed picture. There is no similarity threshold. Rejected submissions do not update the baseline. Session/configuration changes clear it. Direct Capture and computer observations are not deduplicated.

An active computer control suspends automatic submissions, including while the user has paused it. Control state changes cancel an in-progress automatic result. After control ends, the timer waits a full interval; skipped frames are not backlogged.

The queue receives only an image attachment, with no added visible prompt text. Image saving can overlap new user input, so the final idle check and enqueue happen together inside the queue. A refused image is not retried. Saved but unused images remain for attachment residue cleanup.

## Tools, cancellation and shutdown

`capture(signal)` returns bytes even when automatic capture is disabled or no current Session is selected. CaptureTool uses it through Server, which saves the image in the calling Session and binds it to that Turn. Tool permission checks remain in the tool call path.

Automatic and direct captures wait for the active capture request before submitting another. Windows cancellation waits for the native response. On macOS/Linux, cancelling FFmpeg requests process termination and the Promise settles after the process closes.

Switching Sessions, changing capture settings and closing the service cancel the previous automatic result. Even switching A to B and back to A cannot submit the first A capture. `cancelSession` waits for any automatic image save for that Session to finish before the application deletes its files. `close` cancels work, clears the timer and waits for automatic work and the active capture request.

Automatic failures call `onError` unless cancelled. Server publishes a `system_warning`; later timer ticks may try again. Direct capture failures reject the caller's Promise.

## Platform behavior

| Platform | Capture input |
| --- | --- |
| Windows | Bundled computer-use executable uses Windows.Graphics.Capture for the primary display. |
| macOS | First AVFoundation device listed as Capture screen, not camera device 0. |
| Linux/X11 | x11grab using DISPLAY. |
| Linux/Wayland | Rejected; XWayland is not used as a full-desktop substitute. |

Capture excludes audio and cursor output. FFmpeg comes from `ffmpeg-static`; the code does not search PATH or open a visible terminal. Each FFmpeg invocation has a 15-second timeout. macOS device discovery is a separate invocation before capture. Operating-system screen-recording permission and the required capture device must be available.

## Code and checks

[vishotCapture.ts](vishotCapture.ts) contains timer, cancellation and queue coordination. [captureScreen.ts](captureScreen.ts) selects platform input and manages FFmpeg. [Server composition](../../apps/server/src/composition/vishotCapture.ts) supplies the callbacks, and [CaptureTool](../builtin-tools/tools/CaptureTool/captureTool.ts) requests direct captures.

Run `pnpm --filter @ema-agent/vishot-capture test`. Tests cover capture ordering, cancellation, Session switching, saving races, rejected submissions and exact pixel comparison with differently encoded PNG fixtures. They do not read the actual screen. Native Windows desktop checks belong to [computer-use](../../apps/computer-use/README.md); macOS and Linux/X11 still require their own desktop acceptance.
