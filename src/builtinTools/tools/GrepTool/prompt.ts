export const GREP_DESCRIPTION = `Regex content search powered by ripgrep.

Usage:
- ALWAYS use this tool for content search. NEVER invoke \`grep\` or \`rg\` as a Bash command — this tool has correct permission handling.
- Output modes: \`files_with_matches\` (default) — file paths only, newest-modified first; \`content\` — matching lines with optional context; \`count\` — per-file match counts plus a total.
- Filter files with \`glob\` (e.g. "*.ts", "**/*.{ts,tsx}") or \`type\` (e.g. "ts", "py", "rust").
- Results are capped at \`head_limit\` output lines (default 250; in \`content\` mode this includes context lines, so fewer matches may fit). Use \`offset\` to paginate.
- Pattern syntax is ripgrep (not grep): literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\`).
- Multiline: by default patterns match within single lines. For cross-line patterns use \`multiline: true\`.
- For open-ended exploration that may need multiple rounds of globbing and grepping, use a subagent instead.`;
