# Session resource paths and backup

[中文](../zh/sessionResourcePaths.md)

## Behavior

The active data directory groups files by resource type, then Session ID. Managed attachments use `attachments/<sessionId>/`, generated audio uses `audio/<sessionId>/<turnId>/`, downloads use `web-fetch/<sessionId>/`, large tool text uses `tool-results/<sessionId>/`, process logs use `background-processes/<sessionId>/<processId>/`, and temporary notes use `scratchpad/<sessionId>/<turnId>/`.

Storage exposes pure path calculation through `@ema-agent/storage/dataPaths`. Server chooses the data directory and owns Session/Turn cleanup. Subagents share their owning Session's resources; identities and history remain in SQLite. WebFetch download caches are scoped to the Session directory, while Web-only request and directory fields remain outside generic Tool context.

Session backups include existing downloads and persisted tool text along with attachments, audio, process logs, and related database records. Scratchpads and incomplete downloads are excluded. Import restores known file references, retains tool-text modification times, and removes only newly published directories on failure or cancellation. Backup staging stays in `.backup-temp`; final ZIPs go to the user-selected destination.

## Data handling

This layout does not migrate existing runtime directories in place or change the database schema. Back up existing data while Ema and its Server are stopped before resetting the active data directory. Earlier Session ZIPs do not contain downloads or persisted tool text; preserve the complete old data directory separately when those files matter. Import restores the supported contents of an existing Session archive into the current layout. Ordinary external file references remain unchanged.

## Verification

Tests use temporary directories, mock web responses, and temporary or in-memory SQLite databases. They cover resource locations, two-Session download isolation, main-Agent/subagent reuse, attachment and audio reads, tool-text expiry, process logs, Session/Turn cleanup, ZIP round trips, reference rewriting, conflicts, cancellation, and partial-publication/database rollback.

These checks do not establish desktop or installed-build acceptance. Real data backup and reset are separate operations, not part of the automated tests. Native window behavior, fork resource inheritance, and ToolResultGroup rendering are unchanged.
