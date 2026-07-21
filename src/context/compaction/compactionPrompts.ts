// 定义对话压缩与 Session Note 瘦身使用的结构化摘要提示词。
import type { TurnMode } from '@ema-agent/contracts';

// ── Mode-specific compaction templates ───────────────────────────────────────
//
// Each prompt asks the LLM to compress a slice of conversation history into a
// single structured summary. The structure differs by mode so the summary
// captures what each mode cares about. Chat / narrative produce a few
// emotional/narrative sections; agent produces Claude-Code's 9-section
// engineering-task template.

const SHARED_FOOTER = `
Output rules:
  - Respond with ONLY the markdown summary — no preface, no fences.
  - Be concise but factual. Quote specific names, paths, and numbers.
  - Do NOT include "[image]" placeholders or tool_use JSON verbatim — describe them.
  - Do NOT fabricate facts not present in the input.
`;

const CHAT_TEMPLATE = `
Summarise the following conversation between the user and Ema (an AI companion).
Compress it into the structured form below so it can replace the older portion
of the conversation without losing emotional context.

## Current Emotional State
- One short paragraph describing the user's current mood / state of mind.

## Topics Discussed
- Bulleted list, each line: "- {topic}: {one-sentence reaction or stance}".

## Promises Made by Ema
- Things Ema agreed to do, remember, or check on. Empty list if none.

## Pending Threads
- Open conversational threads the user might want resumed later.

## Relationship Milestones
- Any new fact about the user's life (family, work, pets, etc.) that landed
  in this slice. Empty list if none.

## User's Recent Concerns
- Worries / frustrations expressed in the slice, ordered by recency.
`;

const NARRATIVE_TEMPLATE = `
Summarise the following narrative-mode interaction. The user is exploring
Ema's story (three timeline loops). Focus on what the user CHOSE and how the
user REACTED, NOT on the story content itself (story lives in LightRAG).

## Active Timeline
- Which loop / arc was active by the end of this slice.

## Current Scene
- The most recent scene or beat the user was engaged with.

## Player Choices Made
- Bulleted list of branching decisions or stated preferences.

## Pending Plot Threads
- Threads the user asked about but hasn't resolved.

## Character State (Ema's POV)
- Brief description of how Ema is positioned in the narrative right now.
`;

const AGENT_TEMPLATE = `
Summarise the following agent-mode interaction (coding / desktop assistant
work). Use the structured template below. Be thorough but compact.

## Primary Request
- What the user is trying to accomplish in this slice.

## Key Technical Concepts
- Bulleted list of architecture / library / pattern terms touched.

## Files & Code Sections
- "- path/to/file.ts: what it does, what changed".

## Errors and Fixes
- Each: "- {error message excerpt}: {how it was resolved}".

## Problem Solving
- Reasoning that led to the current state. One paragraph max.

## All User Messages
- Bulleted verbatim quotes of every user message in this slice (short).
  This is critical — preserves intent over many turns.

## Pending Tasks
- TODOs explicitly raised but not yet completed.

## Current Work
- What the agent was doing in the very last turn.

## Optional Next Step
- One suggested next action consistent with the user's last expressed intent.
`;

// ── Public builder ───────────────────────────────────────────────────────────

/**
 * Prompt for compressing an over-grown session note in-place.
 * Unlike macrocompaction (which summarises a message slice), this takes the
 * existing note body and produces a tighter version in the same structure —
 * merging redundant entries, removing clearly stale facts, keeping the
 * latest state sections updated.
 *
 * Newest deltas are at the bottom; they carry more recency weight.
 */
export function buildNoteCompactionPrompt(args: {
  mode:   TurnMode;
  body:   string;
}): string {
  const template = (
    args.mode === 'chat'      ? CHAT_TEMPLATE      :
    args.mode === 'narrative' ? NARRATIVE_TEMPLATE :
                                 AGENT_TEMPLATE
  );

  return `You are compressing a Layer-1 session note that has grown too long.
The persisted Layer-1 body is JSON owned by the application, but the content
below is rendered markdown deltas. Rewrite only the markdown content.

Follow these rules strictly:

1. Merge duplicate or redundant entries into a single compact summary.
2. Drop clearly stale facts that have been superseded by newer ones.
3. Newer entries appear closer to the bottom; use that only to judge recency.
4. Do NOT output JSON.
5. Do NOT output HTML comments, timestamp headers, markdown fences, or preface text.
6. Do NOT fabricate facts not present in the input.

${template.trim()}

${SHARED_FOOTER.trim()}

Session note markdown to compress:
${args.body}`.trim();
}

export function buildCompactionPrompt(args: {
  mode:    TurnMode;
  history: string;
}): string {
  const template = (
    args.mode === 'chat'      ? CHAT_TEMPLATE      :
    args.mode === 'narrative' ? NARRATIVE_TEMPLATE :
                                 AGENT_TEMPLATE
  );

  return `You are a conversation compaction agent. Read the slice below and
produce a structured markdown summary that will replace this slice in the
model context. Future turns will see only your summary, not the original
messages.

${template.trim()}

${SHARED_FOOTER.trim()}

Conversation slice to compact:
${args.history}`.trim();
}
