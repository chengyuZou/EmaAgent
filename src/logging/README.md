# Logging

[中文](README-zh.md)

This package formats Node diagnostics as UTF-8 JSONL and saves them directly through a Node file stream. Server initializes it with `<Profile>/logs` before starting the business packages. Business packages choose their event names and fields directly; there is no central business-event registry.

```ts
import { logging } from '@ema-agent/logging';

logging({
  level: 'warn',
  target: 'speech',
  event: 'speech.save_failed',
  message: 'Failed to save speech audio.',
  error,
  body: { sessionId, turnId },
});
```

`logging()` accepts one object and adds the producing process's UTC ISO `time` and `pid`. `target` identifies the business module, such as `speech` or `mcp`; `event` is a fixed event name chosen by that module. Every level is accepted, including debug. `level` describes severity and does not control admission.

`LogRow` defines the saved file format. `message` describes the operation, while `error.message` describes the underlying failure. An unknown thrown value is converted to `LogError`, retaining available name, message, stack, code, HTTP status, and cause. Stacks do not require a switch. Circular or excessively deep cause chains are omitted and marked `truncated`. SDK request, response, and configuration objects are not copied.

`body` contains selected JSON-compatible business values, such as Session IDs, Turn IDs, counts, or durations. It defaults to an empty object. Pass native exceptions through `error`. The contracts and field meanings are documented in [types.ts](types.ts).

`logging.ts` only composes record construction, redaction, length limiting, and output. `internal/record.ts`, `internal/redact.ts`, and `internal/limit.ts` own those transformations. Message text, error content, and business values are redacted on copies using known credential patterns and values registered through `setDiagnosticSecrets()`. Sensitive keys such as `apiKey` cause their values to be redacted; keys themselves stay unchanged. Fixed `target` and `event` identifiers are preserved and must not contain user text or credentials. Callers still select the information worth recording; pattern matching cannot recognize every arbitrary secret.

Records are limited to 8 KiB including the newline. Message and error content share that budget with `body`. Structural limits bound traversal, and very large individual values are omitted whole before redaction rather than exposing an unmatched credential prefix. Later truncation preserves valid UTF-8 JSON and marks `truncated`. Getters and custom `toJSON` functions are not invoked for ordinary body values. Cycles produce an omission marker; repeated references without a cycle remain readable.

## File output and shutdown

Server calls `initializeLogging(directory)` once before business startup. The directory comes from Server; Logging does not import Storage or open a database. Calls before initialization, and one diagnostic after a file failure, use Node stderr. Rust does not parse or persist those messages.

Files are named `ema-<launch time>-<pid>-<sequence>.log`. Each stays within 10 MiB. Startup, rotation, and capacity pressure scan recognized files and remove closed logs older than 14 days or beyond a 100 MiB retention budget. Active streams and files belonging to other processes that still appear alive are preserved. Unrelated files and directories are not removed. Directory scans are synchronous at those boundaries; ordinary appends use the file stream.

A file removed after directory enumeration is skipped. A file already removed when deletion is attempted is deducted from the counted size, so concurrent cleanup does not stop logging or leave a false capacity shortage. Other metadata errors, such as denied access, remain failures because their file sizes cannot be counted reliably.

The stream has a 64 KiB write threshold. A false return from its write accepts that record; new calls are counted and discarded until drain rather than building another queue. After recovery, or at close, `logging.dropped` reports the count. At most the current stream and the previous file finishing rotation remain open. Congestion recovery remains a TODO because discarded content cannot be reconstructed.

`closeLogging(timeoutMs = 2000)` stops admission and waits for accepted writes, fsync, and file closure. It returns false on failure or timeout. Stuck I/O cannot yet be restarted independently; the corresponding TODO remains in the close path. Server calls this after business cleanup. Forced process termination can bypass cleanup, and ordinary writes do not guarantee survival of sudden power loss. Tool command stdout/stderr remain separate execution output.

Run `pnpm --filter @ema-agent/logging build` before `pnpm --filter @ema-agent/logging test`. Tests cover formatting, redaction, UTF-8 limits, cycles and accessors, actual file rotation and retention, concurrent cleanup, congestion accounting, and a real Node subprocess writing its own logs. All file tests use temporary directories.
