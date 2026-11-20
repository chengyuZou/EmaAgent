# Why Node writes bounded JSONL diagnostic files directly

[中文](README-zh.md) | [Documentation](../../README.md)

Server and the business packages under `src/` all run in the Node process. Diagnostic records originate beside model errors, HTTP failures, MCP sessions, and Turn state transitions, so the runtime must decide whether Node emits text for the Rust host to collect or persists structured files itself.

## Why we did not forward logs through the Rust host

An alternative is having Node write logs to stdout or stderr while the Tauri Rust host initializes a native logger, parses those lines, rotates files, and coordinates flushing on shutdown.

That boundary creates two operational issues:

- Standalone Server runs (automated tests, server-only release checks, and local Server launches without the desktop host) would have a different or missing log persistence path from Desktop-hosted runs.
- Routing every structured error, ID, and secret-redacted `body` through child-process stdio forces serialization, line parsing in Rust, and a shutdown API to ensure the host does not terminate Server before queued diagnostics are flushed.

We chose to persist diagnostics directly inside Node through [Logging](../../../src/logging/README.md) under `<Profile>/logs`, while keeping Rust's Server stdout reader focused strictly on the `server.ready` startup notification. Rust does not initialize a logger, format business records, or manage log files.

## Why we bound records and drop under congestion

Diagnostic logging must not become a memory leak or block active conversations when disk I/O stalls or a caller loops on an error:

- **Per-record budget (8 KiB)**: Each JSONL line (`message`, `error`, and `body` together) is capped at 8 KiB. Oversized individual values are omitted before redaction rather than slicing a secret across a boundary, and ordinary getters or custom `toJSON` hooks are not invoked on `body`.
- **Stream backpressure threshold (64 KiB)**: `FileLogWriter` tracks a 64 KiB write threshold and opens at most the active stream plus one rotating file finishing closure. Once the stream sets `writableNeedDrain` or a previous rotation is still closing, new calls are counted and discarded rather than queuing an unbounded backlog in memory. Recovery or closure writes a `logging.dropped` count instead.
- **Tolerant retention cleanup**: Rotation (`10 MiB` per file) and retention (`14 days` or `100 MiB` total) skip files from still-living processes and ignore files already deleted concurrently by another process, avoiding false capacity exhaustion or permanently stopping writes.

## Costs and limits we accept

- **Discarded records cannot be recovered**: Congestion drops log bodies permanently and reports only their count. Recoverable delivery during congestion remains open in [fileWriter.ts](../../../src/logging/fileWriter.ts).
- **Bounded shutdown (`2000 ms`)**: `closeLogging(timeoutMs = 2000)` stops new writes after business cleanup and waits for accepted writes, fsync, and stream closure, returning `false` on timeout or I/O failure. Stuck OS I/O cannot be restarted independently, and forced termination or power loss can still lose buffered tail writes.
- **No central business-event registry**: Modules choose their own `target` and `event` identifiers without a shared schema, so callers must keep user text and secrets out of those fixed strings and use [Logging](../../../src/logging/README.md) contracts when changing recorded fields.
