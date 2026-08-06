// BashTool 的模型说明书, 单点维护。条目主体对照 Claude BashTool/prompt.ts,
// 按我方事实修正(无持久 cwd、15s 转交后台、Process 工具族)。

export const BASH_DESCRIPTION = `Execute a bash/sh shell command inside the workspace sandbox and return stdout, stderr, and exit code.

Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Dedicated tools carry finer-grained permissions and safer output budgets:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- Communication: Output text directly (NOT echo/printf)

# Instructions
- If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt").
- Each command starts in the session workspace; shell state and the working directory do NOT persist between commands. Prefer absolute or workspace-relative paths instead of relying on \`cd\`.
- Avoid interactive commands that read from stdin (they will hang).
- Commands that finish within 15 seconds return their result directly. Slower commands keep running as background processes without being restarted — you will be notified when they complete; do not poll.
- Set runInBackground=true when the command is expected to be long-running. Use ProcessOutput to read incremental output and ProcessStop to terminate it; the full log file path is included in the background reference, so you can also Read it.
- timeout is the total runtime limit in milliseconds. When omitted, the user's background-process setting applies.
- Output redirects (> and >>) may only target paths inside the workspace or the system temp directory.

# Multiple commands
- If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: "git status" and "git diff" can be sent as two parallel calls.
- If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
- Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
- DO NOT use newlines to separate commands (newlines are ok in quoted strings).

# Git safety
- NEVER update the git config.
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requested them. Taking unauthorized destructive actions can result in lost work.
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc.) unless the user explicitly requests it.
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests an amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may destroy work. Instead: fix the issue, re-stage, and create a NEW commit.
- When staging files, prefer adding specific files by name rather than "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries.
- NEVER commit changes unless the user explicitly asks you to.
- Only create commits when requested; if unclear, ask first. Before committing, inspect state with parallel read-only commands: git status (never with -uall), git diff (staged and unstaged), and git log for the message style.
- Pass commit messages via a HEREDOC to preserve formatting, e.g. git commit -m "$(cat <<'EOF' ... EOF)".
- Never use git commands with the -i flag (git rebase -i, git add -i) — interactive input is not supported.

# Avoid unnecessary sleep
- Do not sleep between commands that can run immediately — just run them.
- If your command is long running and you would like to be notified when it finishes — use runInBackground. No sleep needed.
- Do not retry failing commands in a sleep loop — diagnose the root cause.
- If waiting for a background task you started, you will be notified when it completes — do not poll.`;
