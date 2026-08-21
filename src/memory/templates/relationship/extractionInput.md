One Turn of the conversation, as JSON messages (in order). Message types:

- user_message: user text
- assistant_message: assistant text
- user_decision: a direct user answer collected during the turn (prompt / answer)
- characterDirectoryName: the current character's directory name (memory ownership)

Only dialogue text and explicit user decisions are present. Other tool activity is filtered out.

Apply the output format and judgment rules from the system instructions:
extract durable, user-side relationship signals into the markdown structure, or
return exactly NO_MEMORY when nothing is worth saving. Do not output the raw
messages themselves or a transcript recap.

Turn messages follow:

