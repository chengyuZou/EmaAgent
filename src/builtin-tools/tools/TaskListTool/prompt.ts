// TaskListTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const TASK_LIST_DESCRIPTION = `Use this tool to list all persistent tasks in the current Session.

## When to Use This Tool

- Before creating tasks, to avoid duplicates
- After completing a task, to review what remains
- Whenever you need an overall progress snapshot of the Session

## Output

Returns a compact summary of each task:

- **id**: Stable UUID (use with TaskGet, TaskUpdate)
- **displayNumber**: Short per-Session number shown to the user
- **subject**, **status**
- **version**: Current version; pass it as \`expectedVersion\` to TaskUpdate

## Tips

- A task is available to work on when it is \`pending\`
- Prefer lower display numbers when several tasks are available — earlier tasks often establish context for later work
- Use TaskGet for the complete description before starting a task`;
