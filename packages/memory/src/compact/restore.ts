import type { LlmMessage } from '@ema-agent/llm';
import type { TurnMode } from '@ema-agent/contracts';
import type { MemoryDeps } from '../deps.js';
import type { SessionId } from '@ema-agent/contracts';

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_MAX_FILES         = 5;
const AGENT_FILE_TOKEN_BUDGET = 5_000;    // per file
const AGENT_TOTAL_TOKEN_BUDGET = 50_000;
const CHAT_TAIL_TURNS         = 3;
const CHAR_PER_TOKEN          = 4;

// ── Post-compact restore ─────────────────────────────────────────────────────

export interface RestoreContext {
  sessionId: SessionId;
  mode:      TurnMode;
  /**
   * Set of absolute paths that were read in the recent timeline by tools.
   * Provided by the agent engine via its readFileState (the per-turn cache
   * already maintained for file-edit safety). Optional — empty set means we
   * skip file restoration and the model re-reads on demand.
   */
  recentFiles?: ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
}

/**
 * Produce a list of LlmMessages to inject immediately AFTER the new summary
 * message. These re-seed the model with the most concretely useful context so
 * the post-compaction turn doesn't feel amnesic.
 *
 * Mode-specific:
 *   - agent     : up to AGENT_MAX_FILES recently-read files (token-capped)
 *   - chat      : current emotion state notes (currently a placeholder —
 *                 wire EmotionEngine later for V1)
 *   - narrative : current narrative scene from session_notes (Layer 1 already
 *                 carries this; no extra restoration needed)
 *
 * All restored content is wrapped in a single user-role context message so
 * the system prompt cache prefix stays intact.
 */
export function buildPostCompactRestore(
  deps: MemoryDeps,
  ctx:  RestoreContext,
): LlmMessage[] {
  if (ctx.mode === 'agent') return restoreAgent(ctx);
  if (ctx.mode === 'chat')  return restoreChat(deps, ctx);
  return restoreNarrative(deps, ctx);
}

// ── Agent: re-inject recent file reads ───────────────────────────────────────

function restoreAgent(ctx: RestoreContext): LlmMessage[] {
  const files = (ctx.recentFiles ?? []).slice();
  if (files.length === 0) return [];

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sections: string[] = [];
  let totalTokens = 0;
  let used = 0;

  for (const f of files) {
    if (used >= AGENT_MAX_FILES) break;
    if (totalTokens >= AGENT_TOTAL_TOKEN_BUDGET) break;

    const tokenCap = Math.min(
      AGENT_FILE_TOKEN_BUDGET,
      AGENT_TOTAL_TOKEN_BUDGET - totalTokens,
    );
    const charCap = tokenCap * CHAR_PER_TOKEN;

    const truncated = f.content.length > charCap
      ? f.content.slice(0, charCap)
        + `\n\n[... ${f.content.length - charCap} chars truncated; use Read to fetch the rest ...]`
      : f.content;

    sections.push(
      `### \`${f.path}\` (read at ${new Date(f.mtimeMs).toISOString()})\n\n` +
      '```\n' + truncated + '\n```',
    );
    totalTokens += Math.ceil(truncated.length / CHAR_PER_TOKEN);
    used++;
  }

  if (sections.length === 0) return [];

  return [{
    role:    'user',
    content: `<post-compact-restore mode="agent">
The following files were recently read by tools before compaction. Their
contents are re-attached for continuity — call the Read tool again if you
need the full file.

${sections.join('\n\n')}
</post-compact-restore>`,
  }];
}

// ── Chat: re-inject current emotion / mood snapshot ──────────────────────────

function restoreChat(deps: MemoryDeps, ctx: RestoreContext): LlmMessage[] {
  // V1: lean on session_notes.body — emotion engine integration is a future round.
  // We pluck the "Current Emotional State" section if the body has one, else skip.
  const notes = deps.sessionNotes.findBySession(ctx.sessionId);
  if (!notes || !notes.body.trim()) return [];

  const emotionSection = extractMarkdownSection(notes.body, 'Current Emotional State');
  if (!emotionSection) return [];

  return [{
    role: 'user',
    content: `<post-compact-restore mode="chat">
Current emotional snapshot (continuity reminder):

${emotionSection}
</post-compact-restore>`,
  }];
}

// ── Narrative: re-inject active scene/timeline ───────────────────────────────

function restoreNarrative(deps: MemoryDeps, ctx: RestoreContext): LlmMessage[] {
  const notes = deps.sessionNotes.findBySession(ctx.sessionId);
  if (!notes || !notes.body.trim()) return [];

  const scene = extractMarkdownSection(notes.body, 'Current Scene')
             ?? extractMarkdownSection(notes.body, 'Active Timeline');
  if (!scene) return [];

  return [{
    role: 'user',
    content: `<post-compact-restore mode="narrative">
Current narrative state (continuity reminder):

${scene}
</post-compact-restore>`,
  }];
}

// ── Markdown section extractor ───────────────────────────────────────────────

/**
 * Pull text under a `## <heading>` until the next `## ` heading. Used to
 * surgically lift one section out of the session notes body.
 */
function extractMarkdownSection(body: string, heading: string): string | null {
  const lines = body.split('\n');
  let inSection = false;
  const captured: string[] = [];
  for (const line of lines) {
    const isHeading = /^##\s+/.test(line);
    if (isHeading) {
      if (inSection) break;
      if (line.replace(/^##\s+/, '').trim() === heading) {
        inSection = true;
        continue;
      }
    }
    if (inSection) captured.push(line);
  }
  const text = captured.join('\n').trim();
  return text || null;
}
