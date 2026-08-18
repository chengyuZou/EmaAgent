// PowerShellTool 的模型说明书:静态 description(契约冻结),版本差异用保守双写覆盖。
// 结构对照 Claude PowerShellTool/prompt.ts;无 run_in_background(V1 只有前台+超时)。

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const POWERSHELL_DESCRIPTION = `Executes a given PowerShell command on Windows with an optional timeout. Working directory is fixed to the workspace; shell state (variables, functions) does not persist between calls.

IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools instead:
- File search: use Glob (NOT Get-ChildItem -Recurse)
- Content search: use Grep (NOT Select-String)
- Read files: use Read (NOT Get-Content)
- Edit files: use Edit
- Write files: use Write (NOT Set-Content/Out-File)

PowerShell edition notes (this machine runs either Windows PowerShell 5.1 or PowerShell 7+):
- Pipeline chain operators \`&&\` and \`||\` only work on PowerShell 7+. On 5.1 they are a parser error — if a command fails with a parse error, rewrite \`A && B\` as \`A; if ($?) { B }\`. To chain unconditionally: \`A; B\`.
- Ternary (\`?:\`), null-coalescing (\`??\`), and null-conditional (\`?.\`) operators are 7+ only. Use \`if/else\` and explicit \`$null -eq\` checks for compatibility.
- Avoid \`2>&1\` on native executables under 5.1: it wraps each stderr line in an ErrorRecord and sets \`$?\` to \`$false\` even when the exe returned 0. stderr is already captured for you — don't redirect it.
- On 5.1 the default file encoding is UTF-16 LE with BOM. When writing files other tools will read, pass \`-Encoding utf8\` to \`Out-File\`/\`Set-Content\`.
- On 5.1, \`ConvertFrom-Json\` returns a PSCustomObject, not a hashtable; \`-AsHashtable\` is not available.

Before executing the command, follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`Get-ChildItem\` (or \`ls\`) to verify the parent directory exists and is the correct location.

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes.
   - Capture the output of the command.

PowerShell syntax notes:
- Variables use $ prefix: $myVar = "value"
- Escape character is backtick (\`), not backslash
- Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item
- Common aliases: ls (Get-ChildItem), cd (Set-Location), cat (Get-Content), rm (Remove-Item)
- Pipe operator | passes objects, not text; use Select-Object, Where-Object, ForEach-Object for filtering
- String interpolation: "Hello $name" or "Hello $($obj.Property)"
- Registry access uses PSDrive prefixes: \`HKLM:\\SOFTWARE\\...\`, \`HKCU:\\...\` — NOT raw \`HKEY_LOCAL_MACHINE\\...\`
- Environment variables: read with \`$env:NAME\`, set with \`$env:NAME = "value"\` (NOT bash \`export\`)
- Call native exe with spaces in path via the call operator: \`& "C:\\Program Files\\App\\app.exe" arg1 arg2\`

Interactive and blocking commands (will hang — this tool runs with -NonInteractive):
- NEVER use \`Read-Host\`, \`Get-Credential\`, \`Out-GridView\`, \`$Host.UI.PromptForChoice\`, or \`pause\`
- Destructive cmdlets (\`Remove-Item\`, \`Stop-Process\`, \`Clear-Content\`) may prompt for confirmation. Add \`-Confirm:$false\` when you intend the action to proceed. Use \`-Force\` for read-only/hidden items.
- Never use \`git rebase -i\`, \`git add -i\`, or other commands that open an interactive editor

Passing multiline strings (commit messages, file content) to native executables:
- Use a single-quoted here-string so PowerShell does not expand \`$\` or backticks inside. The closing \`'@\` MUST be at column 0 on its own line — indenting it is a parse error:
<example>
git commit -m @'
Commit message here.
Second line with $literal dollar signs.
'@
</example>
- For arguments containing \`-\`, \`@\`, or other characters PowerShell parses as operators, use the stop-parsing token: \`git log --% --format=%H\`

Usage notes:
- The command argument is required.
- Optional timeout in milliseconds, up to ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 60000} minutes). Default ${DEFAULT_TIMEOUT_MS}ms (${DEFAULT_TIMEOUT_MS / 60000} minutes). A command that exceeds its timeout is killed — there is no background mode; keep commands within the timeout.
- Do NOT prefix commands with \`cd\` or \`Set-Location\` — the working directory is already the workspace root.
- When issuing multiple commands: independent commands can be separate parallel tool calls; dependent commands must be chained in one call using the edition-appropriate syntax above.
- Do NOT use newlines to separate commands (newlines are fine inside quoted strings and here-strings).
- Avoid unnecessary \`Start-Sleep\`: do not sleep between commands that can run immediately; do not retry failing commands in a sleep loop — diagnose the root cause instead; if you must poll an external process, use a check command rather than sleeping first.

For git commands:
- Prefer creating a new commit over amending an existing one.
- Before destructive operations (git reset --hard, git push --force, git checkout --), consider whether a safer alternative achieves the same goal.
- Never skip hooks (--no-verify) or bypass signing unless the user explicitly asked. If a hook fails, investigate and fix the underlying issue.

Security: every command is statically analyzed before execution. Commands that obfuscate intent (encoded payloads, download-and-execute patterns) are blocked outright; commands with execution-side-effect potential require explicit user approval. Write plain, readable commands.`;
