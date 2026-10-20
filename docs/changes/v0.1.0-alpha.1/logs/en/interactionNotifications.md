# Windows Permission and AskUser notifications

[中文](../zh/interactionNotifications.md)

## Behavior

Permission and AskUser now use Windows native notifications instead of the stage's `PermissionToastLayer`. The existing chat interaction cards remain available. No new backend response API, permission rule, or persistent interaction queue is introduced.

Only a foreground main window displaying Chat at the request's Session suppresses the native notification. Other Sessions, Settings, and background or minimized main windows can receive it. Each Session exposes only the head of its mixed Permission and AskUser queue; separate Sessions can notify independently.

Permission has Allow, Allow for session, and Deny. All three use the existing Session WebSocket response entry and wait for the backend's resolved event before removing pending state. AskUser has only Close, with answers still entered in Chat. Clicking notification content opens the originating Session. Close and the system X only dismiss presentation, not the request.

Resolved, cancelled, and timed-out requests remove their Windows notifications and history entries. Dismissed notifications are not reposted by ordinary state refreshes. The frontend rejects obsolete or non-head approvals and prevents duplicate native submissions while one is pending. An offline click opens Chat instead of silently queueing an approval.

## Implementation boundary

- Main observes the existing activity and navigation Stores. Named Tauri methods reconcile native presentation and establish a click Channel.
- A Rust MTA thread serializes Windows notification registration, display, and removal. COM activation returns only an action and an existing notification identity; the frontend and backend still validate the live request.
- Debug and release have separate current-user notification identities. Their registration is application-specific and volatile, with cleanup on normal exit and stale-notification cleanup on startup.
- Windows controls rendering and banner availability. Notification settings and Do not disturb remain respected. No custom CSS window or administrator registration is required.
- macOS and Linux retain the in-app interaction UI; this native channel is Windows-only.

## Verification

Focused frontend tests cover mixed queue heads, Session navigation, three Permission actions, Ask navigation without answering, stale and duplicate clicks, serialized IPC, reconnects, offline clicks, and disposal during setup. Existing subagent-consumption tests also pass.

Default native tests check XML escaping, button actions, activation argument validation, and a real Windows COM class-factory/callback round trip without displaying a banner.

An explicitly enabled Windows delivery test uses the real registration and sending functions with an isolated notification identity, test-only COM class, and temporary icon. It verifies notification history and checks asynchronous failure, then removes its notification and registration. It shows a harmless banner for about three seconds; no button approves a real tool. The user confirmed seeing the isolated banner. This is not acceptance of the complete Ema UI response flow or an installed build.

The frontend type check and native compilation have passed.

## Delivery blocked by a settings query

On 2026-10-20, the real sending function failed before `Show` because its `ToastNotifier.Setting()` precheck returned `0x80070490` (`ERROR_NOT_FOUND`). This was not evidence of a missing XML child element or a denied Tauri capability. Using the same registration and payload construction, direct Windows delivery succeeded, and notification history contained one entry.

The regression test first called the application's original sending function and failed with that HRESULT. Removing the `Setting()` precondition made the same test pass, with no asynchronous failure and one history entry. Windows still applies its notification settings and Do not disturb during delivery; the application does not override them.

Run the explicit Windows check from the repository root:

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib windows_accepts_a_real_notification -- --ignored --nocapture
```

The earlier XML-object and COM tests did not reach this precheck or prove delivery. The additional test covers that native boundary without starting Server or reading a user profile. Tauri capability configuration was not changed.

## Remaining acceptance

Rebuild and restart the Tauri host before testing. Verify current-Session suppression, another Session while Ema is foreground, Settings, background and minimized windows, the three Permission buttons, both dismissal paths, body navigation, cancellation and timeout cleanup, mixed queues with subagents, and full application exit. Also check notification-center behavior, Windows notification settings, and the installed release identity. Frontend HMR alone cannot update this native implementation.
