// SubagentTool 的模型说明书, 单点维护。
// 主体对照 Claude AgentTool/prompt.ts(When to fork / Writing the prompt / 示例),
// 按我方事实修正: 无 agent 类型与 worktree;后台族为 SubagentAwait/SubagentSendMessage;
// fork 用 kind 参数表达; 同步等待超 30 秒自动转后台。

export const SUBAGENT_DESCRIPTION = `Launch a sub-agent to handle a complex, multi-step task autonomously. The sub-agent runs its own think→act loop with the same workspace and permission boundaries as you, and reports back when done.

When NOT to use this tool:
- If you want to read a specific file, use Read instead — it is much faster.
- If you are searching for a specific file or class definition, use Glob or Grep instead.
- If the task takes you only a few tool calls, do it yourself instead of delegating.

Usage notes:
- Always include a short description (3–5 words) summarizing what the agent will do — it is shown in the dashboard.
- To launch multiple agents in parallel, emit multiple tool calls in a single message.
- The agent's final report is returned to you but is NOT shown to the user — summarize it for the user yourself.
- The agent's output should generally be trusted.
- Clearly tell the agent whether you expect it to write code or just do research (search, file reads, web fetches) — it is not aware of the user's intent.
- Foreground (default) blocks until the agent finishes — use it when you need the results before you can proceed. A synchronous wait longer than 30 seconds transfers to background automatically and returns the same reference shape.
- runInBackground=true returns the agentRunId immediately. You will be notified when the agent completes — do NOT sleep, poll, or proactively check on its progress. Use SubagentAwait to collect the result within the current turn; use SubagentSendMessage to deliver a mid-run correction (it lands at the agent's next iteration boundary).
- If the parent turn is aborted, running sub-agents are cancelled with it.

## When to fork (kind="fork")

Fork (inherit your conversation context) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative — "will I need this output again" — not task size.
- Research: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message.
- Implementation: prefer to fork work that requires more than a couple of edits. Do research before jumping to implementation.
- The default "subagent" mode starts with zero context — for independent workers that only need the task brief, prefer it over fork.

**Don't peek.** Do not read the agent's intermediate output or transcript while it runs — you get a completion notification; trust it. Reading mid-flight pulls the agent's tool noise into your context, which defeats the point of delegating.

**Don't race.** After launching, you know nothing about what the agent found. Never fabricate or predict its results in any format — not as prose, summary, or structured output. The completion notification arrives as a message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, give the agent's status, not a guess.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — in the default "subagent" mode it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- Terse command-style prompts produce shallow, generic work.
- For a fork, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out. Don't re-explain background it already has.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Examples

<example>
user: "这个分支上线前还差什么?"
assistant: <thinking>这是盘点型问题,我要的是清单,不要把 git 输出留在我的上下文里。开一个 fork。</thinking>
Subagent({ description: "Branch ship-readiness audit", kind: "fork", runInBackground: true,
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words." })
assistant: 审计已在后台运行,结果回来我告诉你。
<commentary>Turn 在这里结束。完成通知会以消息形式在后面的 Turn 到达,不是你自己写的。</commentary>
</example>

<example>
user: "所以那个开关到底接了没"
<commentary>用户在等待期间追问。审计 Agent 正是为了回答这个问题而启动的,但它还没回来。给状态,不要编结果。</commentary>
assistant: 审计还在跑——"开关接线"正是它在查的项之一,应该快了。
</example>

<example>
user: "找个第二意见看看这个迁移安不安全"
assistant: <thinking>子 Agent 看不到我的分析,正好给出独立判断。它需要完整上下文。</thinking>
Subagent({ description: "Independent migration review",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table with a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks? This is research only — do not modify files." })
</example>`;
