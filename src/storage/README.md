# Storage

[中文](./README-zh.md)

This package opens the application's SQLite databases and provides repositories for reading and saving their rows. The host supplies database paths, runs migrations, then passes the matching connection to each repository.

## Open a database

```ts
import { Database, SessionsRepo } from '@ema-agent/storage';

const database = new Database({ path: dataDatabasePath, kind: 'data' });
try {
  database.migrate();
  const sessions = new SessionsRepo(database.sqlite);
  const session = sessions.findById(sessionId);
} finally {
  database.close();
}
```

Create the parent directory before opening a file. Tests can use `{ memory: true, kind: 'data' }`. `migrate()` runs once per instance after a successful migration; `close()` can be called more than once.

| Kind | Usual location | Stored data |
| --- | --- | --- |
| `profile` | `~/.ema-agent/profile.db` | Providers, models and bindings, settings, characters and resource metadata, Skills, MCP configuration and market cache |
| `data` | `~/.ema-agent/data/data.db` | Sessions, Turns, Messages, Tasks, Goals, subagents and Runs, tool executions, background commands, attachment and speech records, usage, Memory jobs and extraction results |
| `narrative` | `~/.ema-agent/narrative/narrative.db` | Fixed story chunks, entities, relations and their vectors for three timelines |

These are host conventions, not paths chosen by `Database`. Attachment bodies, audio, character assets and formal Memory text remain files. Repositories record the paths, indexes and execution state needed to find or manage them.

File connections use WAL, foreign keys, a 5-second busy timeout and `synchronous = NORMAL`. NORMAL can lose recently committed transactions after a power failure. Data connections require FTS5 and register the text extraction and segmentation functions used by search triggers.

## Reads, writes and ownership

Repositories use bound SQL parameters and explicit row types. Many rows keep SQL names such as `session_id` and nullable columns; domain stores convert them to their public types. Import repositories and shared row types from the package root.

Foreign keys, unique indexes and ownership triggers reject invalid associations. Operations spanning several related rows use transactions where the method promises an all-or-nothing change. This is a database guarantee, not a transaction covering files written by other packages.

- `ProvidersRepo.save()` replaces a provider's capability and protocol configuration in a transaction. Removing a capability also removes its dependent model rows. `ProviderModelsRepo.save()` refreshes model facts without changing an existing enabled selection; `setEnabled()` changes that selection.
- `SettingsRepo.read()` distinguishes missing, valid and corrupt JSON. `setMany()` serializes every value before starting its write transaction.
- Task, tool execution and background process mutations use their stored versions or current states to reject outdated updates. A late result must not overwrite a newer execution.
- `createSqliteIdBatches()` deduplicates IDs and divides queries according to the connection's parameter limit, reserved parameters and the package's batch cap.

## History and search

`MessagesRepo.listPage()` loads complete messages. Use `listHeadersPage()` for a message directory and `findById()` when opening a specific body. Pages use `(createdAt, id)` cursors rather than message sequence numbers. Methods document their own ordering.

Effective model history starts at the latest saved summary. Summary coverage is followed back to its original boundary, and later messages are appended without rewriting the stored originals. Main Session history has a bounded read; subagent history has its own query methods and limits.

Normal messages are indexed through SQLite triggers. Chinese segmentation uses the native Jieba dependency when available and a portable character/word fallback otherwise. FTS terms are quoted and joined with OR. Title and fallback text searches escape LIKE wildcards, so user text is not treated as a SQL pattern.

`SessionsRepo.fork()` copies the selected conversation rows and remaps their IDs. It does not copy attachment files or indexes. Copied message blocks can still refer to files under the source Session, so deleting those files can break the references. See [Session](../session/README.md) for the user-facing flow.

## Subagents, jobs and stored files

A subagent identity and one execution are separate rows in `subagents` and `subagent_runs`. The first identity and Run are inserted by the caller inside one transaction. `SubagentRunsRepo.startRun()` starts later executions and updates the identity in its own transaction. A unique index permits only one running Run per identity. Completion updates only the matching running Run.

Forked prefix messages have `run_id = null`. Their original generation source is retained; a subagent's own assistant message obtains that source from its Run. Run history, identity lists and message pages have separate queries, so opening a list does not load every message or execution result.

`MemoryRepo` stores extraction and consolidation jobs in the data database. Claiming, completion and marking explicitly consumed extraction results use SQL transactions. Formal Memory file updates are performed by [Memory](../memory/README.md).

`speech_outputs` records completed WAV files by path, with required byte size and duration in milliseconds. A Turn can have several character versions. Regenerating the same path replaces only that record. `listPage()` returns Turn-level totals, including Turns without audio; `listForTurn()` loads the individual files. Attachment records similarly point to separately managed files.

`SessionBackupReader` exposes row iterables during one synchronous transaction. Consume them inside its callback. `SessionBackupRestorer` inserts related rows in dependency order, checks foreign keys and clears references to unavailable projects or source Sessions. Archive validation, ID replacement and file placement belong to [Backup](../backup/README.md).

## Migrations

Profile and Data each have one initialization file, `001_initial.sql`, and start at database version 1. Application versions such as `0.1.0` do not determine database versions. Do not edit a migration after releasing it; add `002_<change>.sql`, then `003_<change>.sql` for subsequent changes. These files are consecutive numbered SQL files in `migrations/profile` and `migrations/data`. Each migration and its `user_version` update run in one transaction. The runner skips applied versions and runs only the remaining files. A failure rolls back that file's SQL and version update, not previously committed migrations or changes to other database files. Missing numbers and databases newer than the available migrations cause an error. There is no automatic downgrade; use a matching application and a full pre-upgrade backup if a release must be undone. A migration marked `-- ema:migration foreign_keys=off` temporarily disables foreign keys outside the transaction and checks them before committing.

Narrative initialization installs the schema and three seed datasets in a transaction. The seed reader executes SQL incrementally instead of loading every seed file into one string. Narrative repositories read the fixed timeline IDs and return vector buffers or source text as requested. See [Narrative](../narrative/README.md) for retrieval.

`build` copies SQL resources into `dist/migrations`. Shipping only compiled JavaScript is insufficient for a fresh installation.

The optional migration CLI uses `EMA_PROFILE_DIR`, or `~/.ema-agent` when unset, just like the host. It opens `<profile>/profile.db` and `<profile>/data/data.db`. `--data-dir <directory>` changes only the latter. Even `--status` creates directories and opens the databases. Confirm the target and back up real data before running it.

## Read and verify

Start with `database/database.ts` and `database/migrationsRunner.ts`, then follow the relevant repository under `repos/profile`, `repos/data` or `repos/narrative`. The corresponding domain package explains when its writes occur. `search/` contains message indexing and query preparation.

```bash
pnpm --filter @ema-agent/storage test
pnpm --filter @ema-agent/storage typecheck
pnpm --filter @ema-agent/storage build
```

Tests use temporary or in-memory databases and check migrations, row ownership, paging, search, state updates and related-row restoration.
