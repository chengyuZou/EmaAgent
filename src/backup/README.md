# Backup

[中文](./README-zh.md)

Backup exports and imports one Session as a `.ema-session.zip`. It combines database records with managed files: a Session folder alone does not contain its messages.

## Use

```ts
const backup = new SessionBackup(
  activeDataDir,
  sessionBackupReader,
  sessionBackupRestorer,
  modelSelectionExists,
);

const exported = await backup.exportSession(sessionId, destinationPath, signal);
const imported = await backup.importSession(zipFilePath, signal);
```

Create one instance per active data directory. Construction clears that directory's `.backup-temp`, including files left by interrupted operations. Paths refer to the machine running the Server and must be absolute at the HTTP boundary.

The archive contains:

- `manifest.json`: Session ID and resources omitted during export.
- `records/session.json` and JSONL files: Session, Turns, messages, Tasks, Goals, subagent identities/Runs/messages, tool executions, background processes, attachments, speech outputs and usage.
- `files/`: managed attachments, recorded WAV files and background-process output. External file references remain paths.

Records must match the current schemas in [sessionRecords.ts](./records/sessionRecords.ts). There is no archive-version conversion. Older exports may stop being importable when required fields change.

## Export and import order

```mermaid
sequenceDiagram
  participant Caller
  participant Backup
  participant Storage
  participant Disk
  Caller->>Backup: exportSession
  Backup->>Storage: Read records in one transaction
  Backup->>Disk: Write temporary records and copy managed files
  Backup->>Disk: Complete temporary ZIP beside destination
  Backup->>Disk: Rename ZIP to destination
  Backup-->>Caller: filePath and warnings
  Caller->>Backup: importSession
  Backup->>Disk: Extract into temporary directory
  Backup->>Backup: Validate records and references
  Backup->>Disk: Publish complete Session files
  Backup->>Storage: Restore records in one transaction
  Backup-->>Caller: sessionId and warnings
```

Export copies files after the database read transaction ends. Missing or unreadable resources go into `omittedFiles` and warnings; export can still finish. A failed or cancelled ZIP write preserves an existing destination. The destination's parent directory must already exist.

Import reads ZIP entries from disk and streams them into temporary files, checking path traversal, duplicate names and an 8 GiB total expanded limit. JSONL parsing is incremental, with a 16 MiB line limit, but validated records are collected in arrays before restoration. A final newline is required.

Existing Session IDs or target folders cause a conflict; imports are not merged. Managed attachment paths in messages are rewritten to the new data directory, including inherited fork messages. External references stay unchanged. Files are published before the database transaction; a database failure removes only the directory created by this import. Missing model selection is cleared with a warning, while historical model sources remain.

Speech files retain the `<turnId>-<characterName>.wav` name under the Turn audio directory. Subagent identities, Runs, original generation sources and summary cursors remain distinct. Import does not restart work: running Turns become aborted, running subagents/Runs become cancelled, active Goals become paused, in-progress Tasks become pending, and unfinished tools/processes receive terminal states.

## Completion and cleanup

Normal failures and cancellation remove temporary working directories and unfinished ZIPs. A forced process exit may leave a `.ema-session-export-*` directory beside the chosen destination; startup cleanup only covers `activeDataDir/.backup-temp`.

The desktop uses native file dialogs, then passes paths through authenticated HTTP:

| Request | Body | Success |
| --- | --- | --- |
| `POST /api/sessions/:sessionId/export` | `{ destinationPath }` | `200 { filePath, warnings }` |
| `POST /api/sessions/import` | `{ filePath }` | `201 { sessionId, warnings }` |

The [route](../../apps/server/src/routes/backup/sessions.ts) publishes a Session list change after successful import. Cancelling the file dialog sends no request.

## Reading and checking

Start with [sessionBackup.ts](./sessionBackup.ts), then follow export/import orchestration. The `records` directory holds archive schemas and database mappings; `import/archive.ts` handles extraction. Tests use real ZIP files and temporary/in-memory SQLite databases for round trips, failures and cleanup.

```sh
pnpm --filter @ema-agent/backup test
```

HTTP tests live in [Server backup tests](../../apps/server/src/routes/backup/tests), and desktop controls in [data settings tests](../../apps/desktop/src/settings/data/tests). Native dialogs still need desktop verification.
