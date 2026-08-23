// TodoWriteTool 的模型说明书。TODO 只跟踪当前根 Turn，不承担持久 Task 业务。
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

export const TODO_WRITE_DESCRIPTION = `Update the execution checklist for the current root Turn.

Use this tool to keep a complex request organized and to make current progress visible. Each call
replaces the complete checklist; it does not patch or append individual items.

## When to use

- The current request has three or more meaningful steps.
- The work is non-trivial and needs investigation, implementation, and verification.
- The user explicitly asks for a checklist.
- The user gives several separate requirements that must all be completed.
- New instructions materially change the remaining work.
- Before starting an item, mark it \`in_progress\`.
- Immediately after an item is fully completed, mark it \`completed\`.

## When not to use

- A single straightforward action can complete the request.
- The work is purely conversational or informational.
- The checklist would only repeat obvious tool calls such as "read file" and "edit file".
- The work must survive the current Turn, has dependencies, or is delegated to a sub-agent. Use
  ${BuiltinTools.TaskCreate.name}, ${BuiltinTools.TaskGet.name}, ${BuiltinTools.TaskList.name}, and
  ${BuiltinTools.TaskUpdate.name} for that persistent Session work instead.

## Checklist rules

1. Send the entire desired checklist on every call. Items omitted from the new input are removed.
2. Use \`pending\`, \`in_progress\`, and \`completed\` only.
3. Keep at most one item \`in_progress\` at a time.
4. Use \`content\` for the imperative form, such as "Run tests".
5. Use \`activeForm\` for the present continuous form, such as "Running tests".
6. Mark an item completed only after its outcome is real and, where appropriate, verified.
7. Do not mark work completed while tests fail, implementation is partial, or a blocker remains.
8. Remove obsolete items instead of leaving a misleading checklist behind.
9. Do not copy each TODO item into a persistent Session Task.

## Examples

For a multi-step implementation, create a checklist after understanding enough of the codebase:

{
  "todos": [
    {"content":"Inspect the current settings flow","activeForm":"Inspecting the current settings flow","status":"in_progress"},
    {"content":"Implement the settings change","activeForm":"Implementing the settings change","status":"pending"},
    {"content":"Run focused tests","activeForm":"Running focused tests","status":"pending"}
  ]
}

After finishing the first item, replace the full list with its updated state. Do not wait until the
end to batch several status changes. When all items are genuinely complete, submit the full list
with every status set to \`completed\`.

This checklist is historical evidence for the current Turn, not a persistent task queue. A later
Turn may read the old Tool message as history, but it must not treat that old checklist as active.`;
