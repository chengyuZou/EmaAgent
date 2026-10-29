# Permission

[中文](README-zh.md)

Permission decides whether a tool call can proceed, must be refused, or needs the user's confirmation. It owns rule matching and decision order. Tools describe the operation through `checkPermissions(input, context)`; they do not read permission settings or save approvals.

## Entry and ownership

`checkToolPermission(tool, input, toolContext, permissionContext, { interactive })` is the execution layer's only checking entry. It calls the tool's `checkPermissions` inside this package, selects a check implementation, and returns `PermissionCheckResult`.

`PermissionDecision` is allow, deny or ask. `PermissionUserResponse` is the later answer to an ask: allow, allowSession or deny. A direct allow or deny does not create a user interaction.

`PermissionRuleKey` contains a tool name and an optional condition. No condition means the whole tool. `PermissionRule` adds its decision and origin. User and project rules are read when preparing a Turn. Session approvals are read after the tool's asynchronous check, so an existing executor sees newly approved scopes without rebuilding its context.

## Decision order

1. A whole-tool deny ends the check before calling the tool.
2. The tool supplies operation details. File, shell, web, MCP and computer-use checks prepare matching and confirmation requirements.
3. A matching deny refuses the call.
4. A required confirmation with no reusable scope always asks. Computer-use startup can match a Session approval. An already approved computer-use operation does not ask again.
5. A matching Session approval allows its scope.
6. Explicit ask rules and required confirmations ask, including in bypassPermissions mode.
7. BypassPermissions allows ordinary operations that reached this point.
8. Matching allow rules or an operation's default allow permit execution. Other operations ask.

File reads in the workspace default to allow. AcceptEdits also allows ordinary workspace writes. Ordinary writes and reads outside the workspace can be allowed by bypassPermissions; sensitive paths and MCP-reported destructive operations still require confirmation unless their scope already has Session approval. Plan mode keeps its existing restricted ToolPool in Turn preparation.

Checks share this order. File checks interpret paths and workspace membership. Shell checks allow a compound command only when an exact full-command rule matches, or reliable parsed subcommands are all covered. A deny or ask may match any subcommand.

## User confirmation

An ask result contains a message and, only when reusable approval is supported, `sessionApproval: { key, description }`. The message and description reach both the chat card and native notification. The backend keeps the key; clients submit only their choice. Without a description, the UI offers only allow and deny, and the interaction queue rejects allowSession.

Permission does not create a fallback approval for every input. Ordinary tools explicitly select whole-tool or exact-input reuse. File, shell and web checks provide their operation-specific scopes. MCP explicitly uses the tool's complete input because its argument meanings are not standardized.

| Operation | Remembered scope |
| --- | --- |
| Read, Write, Edit, DescribeImage | This tool and the exact file |
| Glob and directory Grep | This tool and the directory with descendants |
| Grep of an unknown network target | This tool and the complete input, without probing the network |
| Bash, PowerShell | The complete literal command, without widening it into a prefix |
| WebFetch | Exact hostname, including its paths and ports but not subdomains |
| WebSearch | Query and normalized allowed/blocked domain lists |
| Computer-use startup | Whole startup tool; allows later starts in this Session, while each use ends with its Turn |

`ToolCallExecution` asks through the host's existing interaction callback. Turn queues the request before publishing it. For allowSession, Turn calls `rememberSessionApproval` before publishing resolution and returning the answer. Execution then checks cancellation before entering the tool. The streaming scheduler continues to own scheduling and ordered result delivery.

## Files and storage

User/project rules stay in the existing Settings entries `permission.rules.user.*` and `permission.rules.project.*`. Their text format is `Tool` or `Tool(condition)`; the parser handles escaped parentheses and backslashes. This package does not require a dedicated SQL table.

`rememberSessionApproval`, `getSessionApprovals` and `clearSessionApprovals` operate on an in-memory Map. Keys may contain only a tool name. Approvals survive normal Turns and are cleared when the Session is removed or the process exits. Computer control state is not duplicated here.

File checks resolve symbolic links and the nearest existing ancestor of new paths. They avoid filesystem queries for network paths before approval. Internal download access requires both the original and resolved paths to remain inside a host-provided read directory. Path matching supports literal file/directory scopes and the existing relative or absolute patterns.

The approval timeout setting remains `permission.askTimeoutMs`. Null means wait without a time limit; cancellation still ends the wait. Only the active Session interaction starts its timeout.

## Layout and verification

`checks/file` and `checks/shell` contain the larger operation families. Web, MCP and computer-use checks each have a file under `checks`. `rules` loads configuration, parses keys and remembers Session approvals. `types.ts` defines public data; the prepared check contract is internal to `checks`.

Run `pnpm --filter @ema-agent/permission test` and `pnpm --filter @ema-agent/permission build`. Builtin-tool, execution, Turn, MCP and Desktop tests cover the real callers, confirmation messages, cancellation and button availability. Rebuild dependent packages before running their tests because workspace imports resolve compiled files.
