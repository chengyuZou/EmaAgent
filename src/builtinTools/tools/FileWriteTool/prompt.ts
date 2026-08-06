// FileWriteTool 的模型说明书, 单点维护。

export const FILE_WRITE_DESCRIPTION = `Write full content to a file, creating it if it does not exist.

- Replaces the entire file - for targeted in-place edits use \`Edit\` instead.
- An existing file MUST have been read in full with \`Read\` before it can be overwritten.
- Parent directories are created automatically.
- Paths are resolved against the session workspace (absolute paths are used as-is).
- Line endings in \`content\` are written as-is (LF preserved, no rewriting).
- After writing, the file is added to the read-state cache so subsequent \`Edit\` calls work without a separate read.`;
