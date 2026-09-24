// TaskCreateTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const TASK_CREATE_DESCRIPTION = `Create a persistent task in the current Session's structured task list. Tasks survive across Turns and app restarts so unfinished work can continue later.

## When to Use This Tool

Use this tool when work cannot be completed in the current Turn and must remain active across later Turns or app restarts. Also use it when the user explicitly asks to create a persistent Session task. Record the unfinished goal, current progress, and what should happen next so a later Turn can continue.

If work initially seemed finishable in this Turn but a real blocker leaves it unfinished, create a Task when that becomes clear. Use TaskUpdate to track its progress and completion; do not create another Task for each step or blocker.

## When NOT to Use This Tool

Skip this tool when:

- The request can be completed in the current Turn, regardless of how many steps it takes; use TodoWrite if an execution checklist helps
- New instructions only change the current Turn's work and do not leave an ongoing task
- The request is purely conversational or informational

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Complete requirements and context. Write enough detail for a future Turn — possibly after compaction or an app restart — to resume the work without re-asking the user.
- **activeForm** (optional): Present-continuous label shown while the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the subject is shown.

All tasks are created with status \`pending\`.

## Tips

- Call TaskList when you need to check whether the ongoing work already has a Task
- Create tasks with clear, specific subjects that describe the outcome`;
