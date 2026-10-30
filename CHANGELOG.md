# Changelog

[中文](./CHANGELOG-zh.md)

## Unreleased

## v0.1.0-beta.2

- Updated the application icon with transparent artwork shared by the desktop app, computer-use executable, notifications, and README.
- Standardized clean builds and pnpm-only dependency locking, removed obsolete commands and configuration, and expanded CI coverage for build inputs.
- Added character stickers with batch import, description editing, and a configuration overview. Described images enter the character Prompt, with an 80,000-character limit for the complete section.
- Split character resource Stores by Live2D, illustrations, reference audio, and stickers. Illustrations support a grid and an overview grouped by expression.
- Updated character/sidebar scrolling, image loading placeholders, sticker display size in chat, and Project-row focus styles.
- Windows computer use ends with its Turn and supports startup approval, window observation, keyboard/mouse actions, and user ending. User changes to the target invalidate old observations.
- Consolidated tool permission decisions and session approval scopes, with explanations when queued inputs cannot be removed or immediately guided.
- Model requests and compaction share media-count and byte budgets, encode sending copies, and omit older media when necessary while retaining local originals.
- LLM completion collects streaming responses internally to address SDK rejection of large non-streaming output budgets, and distinguishes oversized request bodies from token context overflow.
- Existing database upgrades create a pre-migration copy and stop if that copy fails.
- Upgraded Windows desktop dependencies to Tauri 2.12.5 / Tao 0.37.2 to address unresponsiveness with a particular input method during window switching. Dev regression passed for the original input-method scenario and for searching, opening, and starting playback of a Bilibili video.
- Desktop source builds require Rust 1.90 or newer.
- Added design rationale and usage documentation for character switching, media budgets, permissions, speech, and story retrieval.

## Earlier releases

[GitHub Releases](https://github.com/chengyuZou/EmaAgent/releases) contains published version notes and installation artifacts.

Keep Unreleased and concise entries for at most the latest 30 released versions here. Version headings and Git tags use the v prefix. Link to GitHub Releases for older versions. At release time, group Unreleased entries under the exact version; draft documents do not establish publication status.
