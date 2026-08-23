// TaskUpdateTool 的模型说明书:description 是唯一模型可见说明,独立成文件单点维护。

export const TASK_UPDATE_DESCRIPTION = `Use this tool to update a persistent task in the current Session.

## Optimistic Concurrency

Read the latest state with TaskGet or TaskList first, and pass its \`version\` as \`expectedVersion\`. A stale write is rejected with \`version_conflict\` instead of overwriting newer work — re-read and retry.

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`.

- Mark a task in_progress BEFORE beginning the work
- Mark it completed immediately after the work is fully finished and verified
- ONLY mark a task completed when you have FULLY accomplished it. Never mark completed if: tests are failing, implementation is partial, you hit unresolved errors, or you couldn't find necessary files or dependencies
- If blocked, keep the task pending or in_progress and create a new task describing what must be resolved

## Destructive Actions

- \`action: "cancel"\` — work intentionally abandoned; history remains
- \`action: "delete"\` — only for duplicates or mistakenly created tasks; removes the task permanently

An action must be submitted alone — it cannot be combined with any other mutation in the same call.

## Examples

Mark in progress when starting work:
{"taskId": "<uuid>", "expectedVersion": 1, "status": "in_progress"}

Mark completed after finishing:
{"taskId": "<uuid>", "expectedVersion": 2, "status": "completed"}

Cancel abandoned work:
{"taskId": "<uuid>", "expectedVersion": 3, "action": "cancel"}`;
