# Sandbox

[中文](README-zh.md)

Sandbox prepares and runs Bash commands with the machine's available isolation backend. It also provides the process runner used by native PowerShell, plus Bash and terminal-shell discovery.

## Running a command

```ts
import { CommandRunner, probeBash } from '@ema-agent/sandbox';

const bash = await probeBash();
if (!bash.available) throw new Error('Bash is unavailable');
const shell = bash.source === 'wsl'
  ? { kind: 'wsl' as const }
  : { kind: 'native' as const, path: bash.path };

const runner = new CommandRunner({
  cwd: workspace,
  writablePaths: [workspace, temporaryDirectory],
  forbiddenPaths: databaseFiles,
  networkAccess: 'none',
}, shell);

const handle = runner.start('printf hello', { timeoutMs: 5_000, signal });
const result = await handle.completion;
```

Await Bash discovery before constructing a runner, and finish permission checks before starting a command. `start()` synchronously returns `{ completion, stop }`; it does not start another Bash probe.

Server starts discovery when Bash is enabled. During Turn preparation, `prepareTurnTools()` awaits `getCommandRunner()` only if the selected tool pool contains Bash. Plan and tool pools without Bash skip this wait. Discovery is shared across callers; cancelling one Turn does not cancel discovery for everyone. After the wait, Turn preparation checks its own cancellation signal before assembling the tool context.

Server supplies the Session cwd, current project folders, temporary directories and forbidden Profile/Data SQLite files, including companion files. A runner copies these paths and the current network setting. Changes apply to a later runner. Child Agents in the same Turn share the prepared runner.

```text
Server starts Bash discovery
    -> Turn selects its tool pool
    -> if Bash is present, await discovery and construct CommandRunner
    -> permission approval
    -> CommandRunner.start resolves cwd and wraps the command
    -> startProcess returns a handle
    -> completion reports exit or failure
```

An empty capability cwd is rejected. An omitted command cwd uses the Session cwd; a relative cwd is resolved from it. Existing paths use realpath. Other starting directories must fall under a supplied writable root. The original Session cwd remains an allowed starting point after it leaves the project, but that does not grant writes or access to its child directories as new starting points.

## Backends and path rules

`detectBackend()` caches its result for the current process. It runs a wrapped echo command with networking disabled and checks both exit status and a known marker. This proves startup works, not that every file and network restriction has been tested.

| Node process environment | Attempt |
| --- | --- |
| Linux or WSL2 | Start bwrap directly. |
| macOS | Start sandbox-exec with an inline SBPL profile. |
| Windows | Start bwrap through the default WSL distribution. |
| WSL1 | Report unisolated. |

Failure reports `unisolated`, a short `degradeReason`, and `degradeDetails` containing the startup error, stderr, stdout, or missing-marker explanation. Windows launcher output is read as bytes: a UTF-16LE BOM or NUL bytes select UTF-16LE decoding, while ordinary UTF-8 output from Linux commands stays UTF-8. Server normally omits Bash from tool registration after a failed check. Development can opt in with `AGEN_UNSAFE_SHELL=1`; production rejects that override.

Bubblewrap starts with a read-only root, overlays writable directories, then applies read-only and hidden paths. macOS starts with deny-default rules, allows reads and required process operations, then grants selected writes and applies explicit denials.

Root-level HEAD, objects and refs must all exist before existing bare Git repository files are made read-only. An ordinary project config file or hooks directory is not protected by name alone. The runner does not scan for or delete newly created Git files after a command.

Network settings are `none` or `full`, defaulting to none. Unisolated execution does not enforce these file or network rules. Native PowerShell uses its own command-analysis and permission path; it is not isolated by the Bash backend. These wrappers do not configure CPU, memory or process-count quotas.

Windows drive paths use the default WSL `/mnt/<drive>/...` layout. Custom mount layouts are not discovered, and UNC paths are not mapped to WSL mounts.

Server owns the settings-page response type `SandboxStatus`: `backend`, `bashMode`, `networkAccess`, an optional short `warning`, and optional decoded `warningDetails` for expansion. `bashMode` describes the Bash enablement policy, not executable readiness or PowerShell isolation. The frontend obtains this type from the HTTP Route.

## Output, cancellation and failure

`startProcess()` receives an executable, argv, cwd and environment. Bash rebuilds its environment from allowed path, home, temporary-directory and locale variables, with TERM=dumb and PAGER/GIT_PAGER=cat. API credentials and injection variables are not copied. Native PowerShell supplies its own environment.

Each stdout/stderr result retains at most 100,000 UTF-16 code units, including its truncation notice. It keeps the beginning and end without splitting surrogate pairs and removes trailing whitespace. UTF-8 decoding continues across chunks.

`onOutput` receives raw bytes before truncation. It is the output-storage callback: if it throws, the runner requests process termination, continues draining the pipes without calling the failed callback again, then rejects completion after close. BackgroundProcess handles optional UI progress separately; a progress callback failure stops those notifications without stopping logging or execution. Persistent background failures retain the actual failure reason.

| Condition | Completion |
| --- | --- |
| Signal already aborted | No spawn; aborted result with exitCode -1. |
| Spawn error | Rejects. |
| Output-storage failure | Terminates the command, waits for close, then rejects. |
| Normal exit | Returns the exit code; no code becomes -1. |
| Timeout | timedOut is true; aborted remains false. |
| Explicit stop or cancellation | aborted is true unless timeout already won. |
| stop after completion | Does not send another termination request. |

CommandRunner defaults to 120 seconds and caps a supplied timeout at seven days. Windows requests tree termination with taskkill /T /F. POSIX sends SIGTERM to the process group, then SIGKILL after three seconds if needed. Closing the process clears delayed termination timers. A stop request can fail; returning from stop is not proof that all descendants have exited.

## Reading and testing

- [command/commandRunner.ts](command/commandRunner.ts) and [command/commandPaths.ts](command/commandPaths.ts): prepared Bash execution and path rules.
- [process/processRunner.ts](process/processRunner.ts): process lifetime, output and termination.
- [backends/detectBackend.ts](backends/detectBackend.ts): cached backend startup check.
- [discovery/bashProbe.ts](discovery/bashProbe.ts) and [discovery/terminalShells.ts](discovery/terminalShells.ts): Bash lookup and terminal-picker candidates.
- [Server composition](../../apps/server/src/composition/tools.ts): actual paths, enablement policy and status response.
- [PowerShell runner](../builtin-tools/tools/PowerShellTool/powershellRunner.ts): native process path.

Windows Bash discovery tries PATH, the Git executable's installation root, Git registry entries and finally a real Bash command in WSL. Concurrent calls share a Promise. Non-Windows discovery returns the conventional /bin/bash path without checking that executable. Terminal-shell discovery lists existing candidate paths; it does not prove every interactive shell can start.

Run `pnpm --filter @ema-agent/sandbox test` and `pnpm --filter @ema-agent/sandbox typecheck`. Related regressions are in Tools' backgroundProcessRuntime tests, Turn's prepareTurnTools tests and Server's systemStatusRoute tests. Backend-argument tests on Windows do not establish working macOS or Linux/WSL isolation.
