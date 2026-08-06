// GlobTool 的模型说明书, 单点维护。
// description 是模型的唯一说明书: 这里没写的用法, 模型就不知道。
export const GLOB_DESCRIPTION = `Fast file pattern matching using ripgrep's --files mode.

- Supports glob syntax: \`**/*.ts\`, \`src/**/*.{tsx,jsx}\`, etc.
- Returns matching file paths sorted by modification time (newest first) — up to 100 files.
- Use \`path\` to restrict the search to a subdirectory; omit it to search the workspace root.
- Use this tool to find files by name pattern; to search file contents, use Grep instead.
- For open-ended exploration that may need multiple rounds of globbing and grepping, use a subagent instead.`;
