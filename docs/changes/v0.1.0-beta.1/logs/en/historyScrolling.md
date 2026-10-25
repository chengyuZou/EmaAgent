# History jumps while scrolling upward

[中文](../zh/historyScrolling.md)

## Status

Source fixes and isolated browser checks passed on 2026-10-25. Dev feedback suggests the scrolling improved, but extended-session and installed-build acceptance remain unverified. The temporary diagnostic recorder and browser fixtures have been removed. Existing subagent tests remain in place.

## Symptom and evidence

While continuously scrolling upward through History, visible messages could suddenly move against the scrolling direction. Loading an older page could also disturb the reading position. A short period of smoother movement near the top was reported without a precise time marker.

A captured measurement changed a row above the viewport from an estimated 112px to a measured 65px. A visible message then moved from 73px to 36px within the viewport while scrollTop decreased from 4542px to 4532px. That scroll should have moved the message down by 10px. The additional upward displacement was exactly 47px, matching the estimate correction. Other measurements changed 112px to 71px, producing 41px corrections.

This example did not involve pagination or an active animation. Recorded animation properties were color, background-color and opacity. Fractional heights such as 64.5px existed, but rounding them to 65px did not explain the much larger jumps. A later interval with unchanged measured heights had no corresponding row-position shifts, which is consistent with the reported brief improvement near the top.

## Confirmed causes

- `useMessageViewport` disabled TanStack's row-size compensation. Its own layout effect also skipped anchor restoration during ordinary user scrolling. Rows changing from estimates to measured heights therefore moved visible content without a matching scroll correction.
- Restoring the library's default compensation alone left smaller reverse movements in isolated playback. Native scrolling could advance beyond TanStack's cached offset before a resize correction was written. Applying the size delta to that older offset overwrote part of the ongoing movement.
- Programmatic scrolling was identified by comparing a later scroll event with an earlier target. During an older-page insertion, a requested position of 1889px was followed by an actual position of 1866px. The mismatch cleared the persistent prepend-restoration state even though scrolling and measurement were still in progress.
- A wheel event can reach the handler after the compositor has already moved the page. Relying only on the subsequent scroll-event delta could miss the user's downward return to the end and leave following disabled for appended messages.

## Change

[useMessageViewport.ts](../../../../../apps/desktop/src/chat/history/useMessageViewport.ts) retains the existing interface and owns window replacement, prepended-page anchoring, message navigation and following intent. TanStack handles row measurements.

- Row-size adjustments use the actual DOM scrollTop at the time of the write. Absolute navigation retains its requested offset.
- Instant programmatic writes shift the next scroll-event baseline by their actual displacement. User movement that has occurred without a delivered scroll event remains available to the input handler.
- A prepended page restores the previous message ID once. Subsequent estimate corrections use the library's size compensation without a persistent prepend mode.
- Position bounds and tolerance are applied in one helper. Wheel direction and observed movement share the following decision. The 24px near-end UI threshold remains separate from the 1px tolerance used to resume following at the actual end.
- The separate initialized flag and old programmatic-target state were removed. Positioning is derived from window identity and pending navigation. Smooth return-to-end retry and collapsed-row offset limits remain because they have active callers and behavior to preserve.

The temporary recorder, its main-History integration, global console commands and four diagnostic/browser fixture files were removed after the investigation. No database or storage format changed.

## Verification

Before cleanup, 10 viewport browser scenarios and four diagnostic-recorder scenarios passed in isolated headless Edge pages with synthetic messages. The viewport cases covered continuous upward movement, an older-page insertion during scrolling, follow intent near the bottom, native wheel return to the end, movement without a pointer event, a measured row growing above the reader, collapsing the anchor row, interrupted smooth navigation, message/window navigation and initially unloaded History. The two suites reported 16 passing tests including their suite entries.

Desktop TypeScript checking and the five existing subagent message tests passed. These checks used fixtures or mocked APIs without accessing a real user's database or calling a model. After diagnostic cleanup, Desktop type checking and the existing subagent tests were run again.

Installed-build acceptance should repeat continuous upward scrolling through a long conversation, an older-page insertion, reading while messages append, and a downward return to the end. Dev should be fully reloaded after the Hook changes. A reported React `Should have a queue` error was not reproduced in fresh isolated pages using React's development build; a hot-refresh explanation remains unconfirmed and is not treated as a confirmed cause of the scrolling defect.
