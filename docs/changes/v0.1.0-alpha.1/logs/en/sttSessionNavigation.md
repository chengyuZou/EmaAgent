# STT voice input across Session navigation

[中文](../zh/sttSessionNavigation.md)

## Status

Source fix and automated checks passed on 2026-10-20. Real-microphone testing in the Tauri development application and consolidated installed-build acceptance remain pending. No installer was built, no real microphone was opened, and no model request was made during these tests.

## Problem and cause

Recording in Session A continued after switching to Session B, and B showed A's recording or transcription controls. `ChatInput` kept one local recording reference and one local voice state. Existing Session pages reused that component, without stopping recording when the selected Session changed. Replacing the composer with the new-conversation page also cancelled pending work on unmount.

The original transcription callback already captured its Session and read the latest draft. The reproduced failures were missing navigation cleanup and shared component state, not a Server transcription routing error. The Server receives audio, not the destination Session; Desktop decides which draft receives the text.

Before the fix, the initial three component tests had two failures and one pass: switching did not call `MediaRecorder.stop()`, B still showed A's busy state, and manual stop correctly appended text to the latest draft.

## Change

- [voiceInput.ts](../../../../../apps/desktop/src/chat/input/voiceInput.ts) owns pending voice operations and their per-Session display state outside `ChatInput`. Navigation stops the previous recorder and releases its tracks synchronously, without aborting the recorded audio's transcription. A different Session can begin its own recording while earlier requests finish.
- Each completion updates only its owner's latest draft. Returning to that Session restores its pending state and cancel control. Late responses from cancelled operations cannot write text or clear a newer operation.
- Switching while microphone permission is pending discards that request. If a stream arrives afterward, it is closed without creating a recorder.
- [NewSessionPage](../../../../../apps/desktop/src/chat/NewSessionPage.tsx) transfers unfinished dictation with the new draft when first submission creates a Session. [Session removal](../../../../../apps/desktop/src/chat/session/removeSessionFromChat.ts) cancels voice input before clearing the draft and navigating away.
- Opening Settings without changing the selected Session retains the previous recording behavior. This fix does not change TTS generation, playback, STT protocol adapters, or database storage.

## Verification

[chatInputSTTNavigation.test.tsx](../../../../../apps/desktop/tests/chatInputSTTNavigation.test.tsx) mounts the actual composer, voice controls and navigation/draft Stores. Microphone access, native recorder events and STT responses are simulated; unrelated composer controls are isolated. Its 17 cases cover immediate microphone release, independent recording and transcription, out-of-order completion, latest-draft appending, delayed permission, composer remount, new-draft ownership, cancellation, deletion, failure, binding changes and history navigation.

```text
pnpm --filter @ema-agent/desktop exec vitest run tests/chatInputSTTNavigation.test.tsx --maxWorkers=1 --minWorkers=1
Tests 17 passed (17)

pnpm --filter @ema-agent/desktop test -- --maxWorkers=1 --minWorkers=1
Test Files 11 passed (11)
Tests 75 passed (75)
```

Desktop type checking passed. A separate TypeScript check also included the new test file, which the default Desktop configuration does not include.

Remaining Dev check: record a short phrase in A, switch to B before stopping, confirm the microphone indicator stops, and start recording in B while A is still transcribing. A must receive only A's transcription, B only B's, without replacing text typed during the wait. Real STT requests require a configured binding and may incur provider charges.
