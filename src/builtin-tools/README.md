# Builtin Tools

[中文](./README-zh.md)

This package implements the tools the Agent can call: local files and commands, web search and page reading, user questions, Tasks and Goals, Memory and Narrative queries, Skills, subagents and temporary notes. It also supplies their desktop result views.

## Register and execute

```ts
import { registerBuiltinTools } from '@ema-agent/builtin-tools';
import { assembleToolPool, ToolRegistry } from '@ema-agent/tools';

const registry = new ToolRegistry();
registerBuiltinTools(registry, { disableExecuteTools: true });
const pool = assembleToolPool(registry);
```

The Server registers tools once. Turn preparation selects the permitted subset and supplies `ToolUseContext`. A registered tool can still lack a required capability: `validateContext` checks it immediately before a real call. Missing context produces an execution error, rather than making the base registry depend on one Session's environment.

The shared [Tools](../tools/README.md) execution flow validates input, checks context and permissions, executes the tool, saves its result and produces model-visible content. Each tool declares its own input schema, context requirements, concurrency rules and result mapping. `ToolInvocation` carries Session, Turn, tool-call identity and cancellation.

Import execution code from the package root. Desktop renderers use `@ema-agent/builtin-tools/ui`, stable identities use `@ema-agent/builtin-tools/identity`, and Diff shadow-root styles use `@ema-agent/builtin-tools/fileDiff.css`. The UI entry must remain separate from Node execution imports.

## Tool groups

| Group | Tools and behavior |
| --- | --- |
| Files | Read returns text, images, Notebook cells or PDF text. Write replaces full content. Edit replaces a matched string. Glob finds paths; Grep searches text with ripgrep. |
| Commands | Bash uses the supplied CommandRunner. PowerShell starts the detected local executable. ProcessList, ProcessOutput and ProcessStop operate on the current Session's background commands. |
| Web | WebSearch returns titles, URLs and snippets. WebFetch downloads and extracts a known page, with optional raw text and character pagination. |
| User interaction | AskUser waits for structured answers through the host's question channel. It does not fall back to terminal input. |
| Work tracking | TodoWrite replaces the current Turn's checklist in tool input. Task tools use persistent Session Tasks. Goal tools read or update a user-created Goal with its current version. |
| Stored references | Memory tools query formal local Memory files. NarrativeSearch queries the curated story timelines. Skill loads a SKILL.md from the prepared SkillPool. |
| Delegation | Subagent starts or continues an identity; SubagentAwait waits for its result. Scratchpad tools share bounded temporary files within the Turn. |
| Images | Capture uses host-provided screen capture. DescribeImage explicitly calls the configured Vision model when the main model cannot inspect the required image. |

## Files and commands

File paths resolve against the supplied workspace, not the Server process directory. Read and write permission checks consider explicit rules, Session approval, workspace boundaries and sensitive paths. Read, Write and Edit refuse UNC paths even after approval. Destructive command warnings are explanatory text, not permission decisions.

Read saves text state in the Session's FileStateCache. Edit accepts a prior range read; Write requires a full read before overwriting an existing file. Both check whether the file changed since that read. They serialize writes to the resolved target path within this process, write a same-directory temporary file, sync it, then rename it over the target. This does not coordinate with editors or other application processes. Edit/Write return the actual structured Diff and line counts for desktop display. Read text selections keep up to 50 KiB of complete lines; files above 10 MiB require range parameters. Large-file reads still scan to the end to count lines. Images are limited to 5 MiB, Notebook and PDF files to 50 MiB. PDF reads default to 10 pages and accept up to 20 pages per call. OCR and figure descriptions require Vision and optional canvas rasterization; missing capabilities produce page warnings. Pure vector figures do not currently trigger descriptions.

Glob prefers `rg --files` and falls back to Node glob. Grep requires the `rg` executable. Their child-process readers limit elapsed time, bytes and records; a limit returns partial results. Results are sorted and paginated only within the collected candidates, not guaranteed to cover every file after truncation.

Bash registration can be disabled independently of PowerShell. The Server normally disables Bash when no operating-system sandbox is available. PowerShell is a local process, not an isolated execution environment. Its native parser extracts AST data without running the command. Both tools still use the shared permission flow. Static checks are not a substitute for operating-system isolation.

Bash uses synchronous syntax/pattern checks and separate AST-based subcommand extraction for rule matching. Unparseable, dynamic or over-budget input cannot establish a subcommand-wide allow. The TypeScript Bash parser has its own input, time and node limits. PowerShell analysis uses the detected executable, a platform-specific command-size limit and a bounded LRU of parse Promises; transient process failures are removed for retry.

Both command tools share BackgroundProcess: short commands return directly, long commands continue in the background without restarting. Cancellation and runtime limits are handled by the shared process layer. Background references include IDs and log locations. See [Tools](../tools/README.md) and [Sandbox](../sandbox/README.md) for process limits and shutdown behavior.

## Web, stored references and delegation

WebSearch uses Brave when a supported API-key environment variable is set, otherwise Bing's HTML page. It keeps provider order after domain filtering and URL deduplication, then returns at most 10 results. Without domain filters, the request uses the query after trimming outer whitespace. Domain filters add search operators and also check returned URLs. Search snippets are not fetched page bodies.

WebFetch upgrades HTTP to HTTPS, follows redirects, accepts responses up to 10 MiB and times out network work after 30 seconds. Static HTML is extracted and converted to Markdown; it does not execute scripts or use browser login sessions. Converted and raw results use separate 15-minute cache entries, bounded by 50 MiB of content. Permission rules are checked before the preapproved GET-host list. HTML preview frames use an empty sandbox attribute.

Server calls `configureWebDownloads(activeDataDir)` once at startup. WebFetch uses `ToolInvocation.sessionId` to save under `<activeDataDir>/web-fetch/<sessionId>/`; Read recognizes the managed download root without passing a Web-specific directory through Turn context. WebFetch writes the original bytes to a generated filename, publishes the file only after writing finishes, and returns its absolute path and MIME type in `download` plus a model-visible notice. It does not use remote filenames, overwrite user files, or apply text pagination to downloads. Read handles saved PDFs and supported images; saving an unsupported format does not make it readable. Only Read receives automatic access to this managed directory, subject to explicit deny/ask rules and checks against symlink escapes. Other data directories are not granted access.

Download cache entries are scoped to the Session's destination directory, shared between raw and normal calls, and reused only while the saved file exists with the expected size. Main Agents and subagents in that Session share files; a different Session cannot reuse its cached download path. The in-memory cache holds notices, not file bytes. Files survive Turn completion, restarts, and cache expiry, but are removed with their owning Session and included in Session backup. There is no automatic download disk quota or expiry. Downloads remain separate from user attachments. Cancellation or a write error removes the current incomplete file; an abrupt process exit can leave a `.pending` file.

Both web tools call the shared Web request implementation directly. Connections are created on first use and shared by main Agents and subagents in the Server process. Server calls `closeWebRequests()` after cancelling running work. This request function uses its own dispatcher; it does not change model, MCP, or other global `fetch` calls. Bing and WebFetch follow redirects, rechecking proxy bypass rules for each destination. Brave API requests retain manual redirect handling so API credentials are not forwarded to another URL.

Proxy settings are read when the Web connections are first created and retained until those connections are closed. Lowercase environment variables take precedence over their uppercase equivalents. HTTP uses `HTTP_PROXY`, then `ALL_PROXY`; HTTPS uses `HTTPS_PROXY`, then `HTTP_PROXY`, then `ALL_PROXY`. `NO_PROXY` supports exact hosts, leading `.` or `*` suffixes, optional ports, and `*` for all hosts. Without explicit proxy addresses, the Windows desktop host supplies the current user's fixed system proxy and bypass list, including `<local>` and hostname wildcards. PAC/WPAD, SOCKS, invalid settings, and system-settings read failures produce an explicit configuration error instead of silently going direct. macOS, Linux, and standalone Server currently use environment configuration only. Restart Ema after changing proxy settings.

There is no automatic retry or direct fallback after a proxy failure. Network errors retain safe DNS, connection, timeout, and TLS categories through `ToolResult.errorCode`. Non-2xx responses preserve the HTTP status and valid `Retry-After` value. Error excerpts read at most 4 KiB for up to one second, remove markup and known request credentials, and return at most 500 characters as untrusted text, never as cached page content. Caller cancellation stays cancellation. A working proxy does not grant website access or turn an HTTP reader into an interactive browser.

Memory returns user-related Work and Relationship references. NarrativeSearch returns canon story evidence grouped by relevant timeline, with separate failures; it is not conversation Memory. Their host query functions define the actual storage and retrieval behavior. Tool result objects and model-visible text can differ, so inspect `mapResultToModelContent` as well as `execute` when changing output.

Subagent foreground waiting transfers to background after 120 seconds. Cancelling a foreground wait cancels that child; background children have their own lifetime. Scratchpad writes are serialized per directory, limited to 64 keys, 256 KiB per value and 8 MiB total. They are temporary Turn files, not persistent Tasks or final deliverables.

## Read and verify

Start at `index.ts` for registration and exports, then open a tool's implementation, `prompt.ts`, optional `UI.tsx` and matching tests. Web networking, content extraction, and cache/download storage live under `tools/WebFetchTool/network`, `content`, and `storage`; WebSearch reuses the networking code. Shared path and shell permission behavior lives under `tools/shared`. Shell AST and pattern checks live beside each shell tool.

```bash
pnpm --filter @ema-agent/builtin-tools typecheck
pnpm --filter @ema-agent/builtin-tools test
pnpm --filter @ema-agent/builtin-tools build
```

The regular suite uses temporary files, test databases, fake command runners and mocked HTTP responses. `tests/PowerShellLive.test.ts` additionally exercises the installed PowerShell when `EMA_LIVE_PWSH=1`. Parser unit tests and jsdom result-view tests do not establish complete shell-security or native-window behavior.
