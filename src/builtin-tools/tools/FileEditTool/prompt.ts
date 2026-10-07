export const FILE_EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- Read this file before editing it. A ranged Read using offset/limit is sufficient; the read state is retained across turns in this session.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Typographic/curly quotes in \`old_string\` are normalized automatically, so literal quotes from your output still match curly-quote source files.
- LF and CRLF are normalized for matching; the file's existing line-ending style is preserved when writing.
- The file must not have been modified externally since it was read; if it was, re-read it before editing.`;
