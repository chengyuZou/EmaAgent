// TaskGetTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const TASK_GET_DESCRIPTION = `Use this tool to retrieve one task from the current Session by its stable taskId (UUID).

## When to Use This Tool

- Before updating a task: TaskUpdate requires the task's latest \`version\` as \`expectedVersion\` and rejects stale writes instead of overwriting newer work
- When you need the full description and context before starting work
- To inspect the dependency graph (blocks / blockedBy) and whether an AgentRun is currently working on the task

## Output

Returns full task details:

- **id**: Stable UUID (use with TaskUpdate)
- **displayNumber**: Short per-Session number for display and quick reference
- **subject**, **description**, **activeForm**, **status**
- **blocks**: Tasks that cannot start until this one completes
- **blockedBy**: Tasks that must complete before this one can start
- **activeAgentRunId**: Present only while a sub-agent run is actively working on this task
- **version**: Current version; pass it as \`expectedVersion\` to TaskUpdate

## Tips

- A task with unresolved blockedBy entries must not be started
- Use TaskList for a compact view of the whole Session
- A missing task returns null rather than an error — it may have been deleted`;
