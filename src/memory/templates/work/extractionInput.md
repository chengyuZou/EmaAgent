One Turn of the conversation, as JSON messages (in order). Message types:

- user_message: user text
- assistant_message: assistant text
- user_decision: a direct user answer collected during the turn (prompt / answer)
- tool_call: assistant tool invocation (toolCallId / toolName / input is the JSON of the arguments)
- tool_result: tool result (toolCallId matches a tool_call; isError marks failure)
- workspaceRoot: workspace root for this turn (absent when there is no workspace)

Apply the output format and judgment rules from the system instructions:
extract reusable work facts into the task-first markdown structure, or return
exactly NO_MEMORY when nothing is worth saving. Do not output the raw messages
themselves or a transcript recap.

Turn messages follow:

