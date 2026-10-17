# Usage

[中文](README-zh.md)

Usage saves the reported usage of each completed model API request in the active data database. LLM, Vision, Embed, Rerank, TTS and STT callers supply a full `UsageRecord` after their request completes, fails or is cancelled.

## Recording and reading

```ts
import { UsageRecorder } from '@ema-agent/usage';

const usage = new UsageRecorder(dataDb);
usage.record(record);
const page = usage.list({ sessionId, capability: 'llm', limit: 50 });
const nextPage = page.nextCursor
  ? usage.list({ sessionId, capability: 'llm', limit: 50, cursor: page.nextCursor })
  : null;
const turnRecords = usage.forTurn(turnId);
```

The caller supplies a unique physical request ID, provider, model, optional Session and Turn IDs, final status and reported counters. Background requests can have null Session and Turn IDs. `createdAt` is the request start time in Unix milliseconds, even though the row is written after the request ends.

`record` maps business fields to SQL columns and inserts through Storage's `UsageRecordsRepo`. A duplicate ID or other database write failure produces a warning and leaves the model request's result unchanged. Records are not updated in place. Query errors propagate to the caller.

`list` accepts Session, capability, limit and cursor filters. Results are ordered by start time, then ID, newest first. The default limit is 100, clamped to 1 through 500. Use both fields of `nextCursor` for the next page. `forTurn` returns that Turn's records oldest first.

## Reading the numbers

- Unknown or inapplicable counters stay `null`. They do not mean zero or free.
- `inputTokens` already includes cached input. Do not add cache-read or cache-write counters to it again.
- `quantity` must be read with `unit`. TTS uses submitted text length in UTF-16 code units with `character`; STT uses known audio seconds with `second`.
- `durationMs` measures request time, including streaming until it ends. It is not the playback duration of generated audio.
- Failed and cancelled requests can still report usage.

## Integration and checks

[record.ts](record.ts) contains the SQL mapping and query entry points; [types.ts](types.ts) explains the counters. Storage owns the [table operations](../storage/repos/data/usage-records.ts). The [Usage route](../../apps/server/src/routes/usage.ts) serves `GET /api/usage/records`; its `beforeCreatedAt` and `beforeId` parameters must be supplied together. Usage emits no change event; consumers query saved records.

Run `pnpm --filter @ema-agent/usage test`. Tests use a real in-memory SQLite database and check field mapping, terminal statuses, pagination, SQL rejection and write-versus-read error handling.
