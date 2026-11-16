# System

[中文](README-zh.md)

System provides local disk and available-memory queries along with the shared `SystemWarningEvent` type for application warnings.

```ts
import { checkAvailableMemory, getDisksInfo } from '@ema-agent/system';

const disks = getDisksInfo();
const availableBytes = checkAvailableMemory();
```

`checkAvailableMemory()` wraps Node's `process.availableMemory()` across Windows, macOS, and Linux, validates that the result is a finite non-negative byte count, and throws on invalid or failed reads. Tools uses it before starting shell commands.

`getDisksInfo()` synchronously returns mount, label, total bytes and unused bytes for each disk. Windows queries `Win32_LogicalDisk` through PowerShell, explicitly using UTF-8 JSON so volume labels survive decoding. macOS and Linux run `df -Pk`, which reports filesystem usage in 1024-byte blocks.

On POSIX, `free` is total minus used, not the command's available-to-user column. It can include reserved space that an ordinary user cannot use. Mount paths containing whitespace are not reconstructed by the current column parser. The query has a five-second timeout and returns an empty list on command or parsing failure.

The [Server status route](../../apps/server/src/routes/system/status.ts) returns these disks alongside the active data directory. The data directory is supplied by Server, not inferred from disk information.

`SystemWarningEvent` carries `type: 'system_warning'`, a level and a user-facing message. Producers, such as automatic screen capture, publish it through Server application events; Desktop's notification handlers display it.

Disk queries are in [disk.ts](disk.ts), memory checks are in [checkAvailableMemory.ts](checkAvailableMemory.ts), and the warning shape is in [events.ts](events.ts). Run `pnpm --filter @ema-agent/system typecheck` and `pnpm --filter @ema-agent/system test`. Unit tests in `tests/checkAvailableMemory.test.ts` cover memory checks; there is currently no automated test suite for the platform disk commands.
