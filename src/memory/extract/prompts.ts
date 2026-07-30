import type { ExecutionProfile } from '@ema-agent/turn';


// ── Extraction LLM prompts (one template per execution profile) ─────────────

/**
 * Each profile's extraction prompt asks the LLM to scan the pending conversation
 * fragments and emit a single JSON object with four arrays:
 *   new_nodes / new_edges / memory_items / session_note_delta
 *
 * Profile only changes the extraction focus. Narrative is an independent RAG
 * capability and never creates a third Memory profile.
 */

const SHARED_FOOTER = `
Respond with a single JSON object — no prose, no markdown fences. Schema:

{
  "new_nodes": [
    {
      "label":       string,        // short identifier — e.g. "橘子(猫)", "工作压力"
      "node_type":   "user_fact" | "entity" | "event" | "emotion" | "preference" | "relationship",
      "description": string,        // one-paragraph factual summary
      "importance":  0-100,         // how much this matters long-term
      "evidence_quote": string      // verbatim quote (>=8 chars) copied from the
                                    // conversation above that directly supports this fact
    }
  ],
  "new_edges": [
    {
      "from_label": string,   // must match an existing node OR a new_node label
      "from_type":  string,   // optional node_type of the endpoint — REQUIRED when the
                              // label is shared by multiple nodes (disambiguates which one)
      "to_label":   string,
      "to_type":    string,   // same rule as from_type
      "relation":   string    // free-form verb / preposition: "养", "担心", "经历", "讨厌"
    }
  ],
  "memory_items": [
    {
      "kind":       "user" | "feedback" | "project" | "reference",
      "title":      string,         // < 100 chars, distinctive
      "body":       string,         // few-sentence detail; include the WHY
      "importance": 0-100,
      "evidence_quote": string      // verbatim quote (>=8 chars) from the conversation,
                                    // same rule as new_nodes
    }
  ],
  "session_note_delta": string      // incremental markdown to APPEND to the running session summary
}

Empty arrays / empty string are acceptable. Return {} only if nothing is worth extracting.
Avoid duplicating facts that already exist in the provided "Existing node labels" list.
Every extracted node and memory item must carry an evidence_quote copied word-for-word
from the conversation. If no verbatim evidence exists for a claim, do not extract it —
an unverifiable long-term memory is worse than a missing one.
`;

const CHAT_HEADER = `
You are EmaAgent's chat-mode memory extractor. Your job is to read the user's
recent conversation with Ema and capture durable facts about who the user is,
how they feel, what they care about, and how they relate to people / pets /
things in their life. These are surfaced to Ema in future turns so she
remembers the user the way a close friend would.

Focus areas:
  - user_fact      : identity attributes (job, location, age, family makeup)
  - preference     : likes, dislikes, communication styles
  - emotion        : recurring or notable emotional patterns
  - entity         : people, pets, places, objects the user mentions repeatedly
  - relationship   : how the user relates to those entities ("用户 -养- 橘子")
  - memory_items   : self-contained facts that don't fit the graph
                     (use kind="user" for identity, "feedback" for
                     conversation style preferences)
  - session_note_delta: a short markdown paragraph summarising what was
                        discussed / how the user felt / open threads.

DO NOT extract:
  - 临时状态与日程（"这周很忙"、"明天要出差"）——它们会过期，几周后就是误导
  - 一次性情绪（"今天心情不错"）——只有反复出现的情绪模式才值得长期记忆
  - 当前对话的过程信息（"我们正在聊 X"）——那是 session_note_delta 的职责
  - 能由其他长期事实直接推出的冗余结论
`;

const WORK_HEADER = `
You are EmaAgent's work-profile memory extractor. The user is using Ema as a
coding / desktop assistant. Capture durable facts that help future agent
sessions work better with this person.

Focus areas:
  - memory_items.kind="project"    : ongoing project facts — repo layout,
                                     conventions, deadlines, decisions made
  - memory_items.kind="feedback"   : explicit corrections from the user
                                     ("don't mock the DB", "use 2 spaces")
                                     — ALWAYS include the WHY
  - memory_items.kind="user"       : durable user attributes (preferred
                                     languages, skill level, role)
  - memory_items.kind="reference"  : pointers to external systems
                                     ("issues live in Linear project FOO")
  - new_nodes (user_fact/preference): cross-profile user identity facts —
                                      surfaces in chat mode too
  - session_note_delta             : current task, files touched, decisions
                                      pending — replaces what was there

DO NOT extract code snippets, commit hashes, or git history — those are
re-derivable from the workspace.
`;

export function buildExtractionPrompt(args: {
  executionProfile: ExecutionProfile;
  fragments: Array<{ role: string; content: string }>;
  existingNodeLabels: string[];
}): string {
  const header = args.executionProfile === 'chat' ? CHAT_HEADER : WORK_HEADER;

  const conversation = renderFragmentsForPrompt(args.fragments);

  const existing = args.existingNodeLabels.length === 0
    ? '(none yet)'
    : args.existingNodeLabels.join(', ');

  return `${header.trim()}

Existing node labels (avoid duplicates):
${existing}

Conversation fragments to extract from:
${conversation}

${SHARED_FOOTER.trim()}`;
}

/** 渲染对话片段的统一口径；举证校验以同一份文本为基准。 */
export function renderFragmentsForPrompt(
  fragments: Array<{ role: string; content: string }>,
): string {
  return fragments
    .map(f => `[${f.role}] ${f.content}`)
    .join('\n');
}
