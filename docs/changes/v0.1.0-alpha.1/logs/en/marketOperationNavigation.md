# Market operation state across settings navigation

[中文](../zh/marketOperationNavigation.md)

## Status

Source fix and automated regression checks passed. On 2026-10-20, the user confirmed that the Skills and MCP market changes also passed testing in the Tauri development application. Installed-build acceptance is deferred until the remaining reported issues have been addressed. No installer was built or tested for this fix.

## Problem and reproduction

Starting a Skill installation or MCP market addition showed a busy button. Leaving the settings page and returning before completion removed that feedback, although the submitted operation continued. Multiple targets could be active at once.

Tests mounted the actual market pages, Stores and shared UI with in-memory API responses. An installation remained pending while the page was unmounted and mounted again. Before the fix, the two market suites had five failing cases and seven passing cases. The failures checked the missing busy state, repeated submissions and the current Skill page not updating after completion.

## Cause

The settings panel unmounts its previous subpage. Each market page held its own in-progress Set, so the new page started with an empty Set.

The Skill market also refreshed its list from the old page's completion callback. The existing Skill Store refreshed the installed-skill directory on `skills_changed`, but the new market page did not refresh its own market list or detail. MCP already refreshed a shared server list after addition, so its completed result could appear even though its busy state had disappeared.

Backend Skill installation already rejected concurrent requests for the same source and slug. The frontend test's duplicate API call did not establish that the backend installed the same Skill twice.

## Change

- [Skill Store](../../../../../apps/desktop/src/stores/skill.ts) owns `installingMarketIds` and `installFromMarket`. The key is `source:slug`. It submits the request, reports success or failure and removes only that operation's key when it ends.
- [SkillMarketPage](../../../../../apps/desktop/src/settings/skills/SkillMarketPage.tsx) reads the shared Set. Its current list and detail subscribe to the existing `skills_changed` event. Older queries cannot replace newer results or reopen a closed detail. Uninstall still uses its existing API and local operation state, with the same event refreshing its result.
- [MCP Store](../../../../../apps/desktop/src/stores/mcp.ts) owns `addingMarketEntryIds` and `addFromMarket`, keyed by the current Official market's `externalId`. It refreshes the shared server list after adding the configuration. Backend `connectionStatus` remains the source of connection information; an added configuration is not a successful connection.
- A concurrent MCP test also reproduced an older server-list response overwriting a newer list and hiding another completed addition. Only the latest list request now updates shared state. Each refresh returns its own error or null, so another request's error cannot determine the current addition's feedback.

Search, filters, pagination, detail selection and confirmation dialogs remain page state. Leaving the page does not cancel a submitted installation. A successful installation followed by a failed list or detail read is reported separately from an installation failure. These changes do not add restart recovery, database persistence or a generic task Store.

## Verification

| Test | Passing cases | Scope |
| --- | ---: | --- |
| [skillMarketOperations.test.tsx](../../../../../apps/desktop/tests/skillMarketOperations.test.tsx) | 14 | Single and concurrent installations, navigation, completion while absent, retry, per-source deduplication, current detail refresh, stale responses, read errors and uninstall refresh |
| [mcpMarketOperations.test.tsx](../../../../../apps/desktop/tests/mcpMarketOperations.test.tsx) | 8 | Single and concurrent additions, navigation, market queries, background completion, deduplication, connection-state ownership, refresh failure and out-of-order list responses |
| [speechGenerationNavigation.test.tsx](../../../../../apps/desktop/tests/speechGenerationNavigation.test.tsx) | 4 | Existing Chat and data TTS regeneration paths, with no TTS business changes |
| [settingsInteractions.test.tsx](../../../../../apps/desktop/tests/settingsInteractions.test.tsx) | 7 | Existing settings interactions |

```text
pnpm --filter @ema-agent/desktop exec vitest run tests/skillMarketOperations.test.tsx tests/mcpMarketOperations.test.tsx tests/speechGenerationNavigation.test.tsx tests/settingsInteractions.test.tsx --maxWorkers=1 --minWorkers=1
Test Files 4 passed (4)
Tests 33 passed (33)
```

Desktop type checking passed. A separate TypeScript check included both market test files with the desktop configuration and also passed. The automated tests did not perform real downloads, installations, paid calls or user-database reads.

The user's subsequent Dev acceptance is separate from those simulated API tests. Chat and data TTS regeneration had already passed the user's installed-app tests and was excluded from this fix. STT recording across Session changes remains a separate issue.
