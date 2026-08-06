// FileEditTool 的模型说明书, 单点维护。
// 条目对照 Claude FileEditTool prompt.ts, 只按我方事实修正(整读要求/引号归一/mtime 守卫)。

export const FILE_EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once before editing this file. This tool will error if you attempt an edit without reading the file — and the read must cover the whole file (no offset/limit).
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Typographic/curly quotes in \`old_string\` are normalized automatically, so literal quotes from your output still match curly-quote source files.
- The file must not have been modified externally since it was read; if it was, re-read it before editing.`;
