// TaskCreateTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const TASK_CREATE_DESCRIPTION = `Use this tool to create a persistent task in the current Session's structured task list. Tasks survive across Turns and app restarts; they track progress, organize complex work, and show the user what is being worked on.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step work — when a request requires 3 or more distinct steps or actions
- Non-trivial tasks — work that requires careful planning or multiple operations
- User explicitly requests a task list — when the user directly asks for one
- User provides multiple tasks — numbered or comma-separated lists of things to be done
- After receiving new instructions — immediately capture new requirements as tasks
- When you start working on a task — mark it as in_progress via TaskUpdate BEFORE beginning work
- After completing a task — mark it completed via TaskUpdate and create any follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip this tool when:

- There is only a single, straightforward action
- The work is trivial and tracking it provides no organizational benefit
- It can be completed in less than 3 trivial steps
- The request is purely conversational or informational

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Complete requirements and context. Write enough detail for a future Turn — possibly after compaction or an app restart — to resume the work without re-asking the user.
- **activeForm** (optional): Present-continuous label shown while the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the subject is shown.

All tasks are created with status \`pending\`.

## Tips

- Call TaskList first to avoid creating duplicate tasks
- Use TaskUpdate with addBlocks/addBlockedBy to set up dependencies after creation
- Create tasks with clear, specific subjects that describe the outcome`;
