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

WebFetch upgrades HTTP to HTTPS, follows redirects, accepts text responses up to 10 MiB and times out network work after 30 seconds. Static HTML is extracted and converted to Markdown; it does not execute scripts or use browser login sessions. Converted and raw results use separate 15-minute cache entries, bounded by 50 MiB of content. Permission rules are checked before the preapproved GET-host list. HTML preview frames use an empty sandbox attribute.

Memory returns user-related Work and Relationship references. NarrativeSearch returns canon story evidence grouped by relevant timeline, with separate failures; it is not conversation Memory. Their host query functions define the actual storage and retrieval behavior. Tool result objects and model-visible text can differ, so inspect `mapResultToModelContent` as well as `execute` when changing output.

Subagent foreground waiting transfers to background after 120 seconds. Cancelling a foreground wait cancels that child; background children have their own lifetime. Scratchpad writes are serialized per directory, limited to 64 keys, 256 KiB per value and 8 MiB total. They are temporary Turn files, not persistent Tasks or final deliverables.

## Read and verify

Start at `index.ts` for registration and exports, then open a tool's implementation, `prompt.ts`, optional `UI.tsx` and matching tests. Shared path and shell permission behavior lives under `tools/shared`. Shell AST and pattern checks live beside each shell tool.

```bash
pnpm --filter @ema-agent/builtin-tools typecheck
pnpm --filter @ema-agent/builtin-tools test
pnpm --filter @ema-agent/builtin-tools build
```

The regular suite uses temporary files, test databases, fake command runners and mocked HTTP responses. `tests/PowerShellLive.test.ts` additionally exercises the installed PowerShell when `EMA_LIVE_PWSH=1`. Parser unit tests and jsdom result-view tests do not establish complete shell-security or native-window behavior.
