// 调用当前模型生成旧对话摘要，不负责持久化或最终上下文预算判定。
import type { AssistantBlock, LanguageModel, Message as ModelMessage, UserBlock } from '@ema-agent/llm';
import type { TurnMode } from '@ema-agent/contracts';
import { buildCompactionPrompt } from './compaction-prompts.js';
import { estimateMessagesTokens } from '@ema-agent/token';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TRUNCATE_FRACTION = 0.2;   // each retry drops the oldest 20%
const MIN_PRESERVE_MESSAGES = 4; // never compact below this many tail messages

/** Fraction of context window that triggers compaction (i.e. messages > 85% → compact). */
const COMPACTION_TRIGGER_RATIO = 0.85;
/** Fraction of context window reserved for the compaction summary output. */
const COMPACTION_OUTPUT_RATIO  = 0.20;
/** Minimum output tokens for the compaction LLM call (small-model floor). */
const MIN_COMPACTION_OUTPUT    = 2000;

// ── Slice formatting (for the LLM input) ─────────────────────────────────────

function formatHistory(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;        // never feed system back to summariser
    if (typeof msg.content === 'string') {
      lines.push(`[${msg.role}]\n${msg.content}\n`);
      continue;
    }
    const parts: string[] = [];
    for (const blk of msg.content) {
      parts.push(formatBlock(blk));
    }
    lines.push(`[${msg.role}]\n${parts.join('\n')}\n`);
  }
  return lines.join('\n');
}

function formatBlock(blk: UserBlock | AssistantBlock): string {
  const tag = (blk as { type?: string }).type;
  switch (tag) {
    case 'text':         return (blk as { text: string }).text;
    case 'thinking':     return '';
    case 'tool_use': {
      const t = blk as { name: string; args: unknown };
      return `<tool_use name="${t.name}">${JSON.stringify(t.args)}</tool_use>`;
    }
    case 'tool_result': {
      const t = blk as { content: string | unknown[]; isError?: boolean };
      const body = typeof t.content === 'string' ? t.content : '[non-text result]';
      return `<tool_result${t.isError ? ' error="true"' : ''}>${body}</tool_result>`;
    }
    case 'image_url':
    case 'image_data':
    case 'audio_data':
    case 'file_url':
    case 'file_data':    return `[${tag}]`;
    default:             return '';
  }
}

// ── Image stripping (preserve order, replace with placeholder text) ──────────

const MEDIA_TYPES = new Set(['image_url', 'image_data', 'audio_data', 'file_url', 'file_data']);

function stripImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const next: UserBlock[] = msg.content.map((blk) => {
      const t = (blk as { type?: string }).type;
      if (t && MEDIA_TYPES.has(t)) return { type: 'text', text: `[${t}]` };
      // Also strip media nested inside tool_result content arrays
      if (t === 'tool_result') {
        const tr = blk as { type: 'tool_result'; toolUseId: string; content: string | unknown[]; isError?: boolean };
        if (Array.isArray(tr.content)) {
          const stripped = tr.content.map((part) => {
            const pt = (part as { type?: string }).type;
            return (pt && MEDIA_TYPES.has(pt))
              ? { type: 'text' as const, text: `[${pt}]` }
              : part;
          });
          return { type: 'tool_result', toolUseId: tr.toolUseId, content: stripped, isError: tr.isError ?? false } as UserBlock;
        }
      }
      return blk;
    });
    return { role: 'user', content: next };
  });
}

// ── Macrocompaction core ─────────────────────────────────────────────────────

export interface MacroCompactArgs {
  llm:           LanguageModel;
  /** Current turn's provider — compaction uses the same model the user picked. */
  providerId:    string;
  /** Current turn's model. */
  model:         string;
  mode:          TurnMode;
  /** Messages to summarise (older portion). */
  toCompact:     ModelMessage[];
  /**
   * Token limit we MUST land below. If the history slice exceeds this window,
   * the oldest messages are truncated to fit before summarisation (same
   * behaviour as Claude Code — truncate to current model's capacity).
   */
  modelContextWindow: number;
  signal?:       AbortSignal;
}

export interface MacroCompactResult {
  /** Compacted summary text. Empty string when compaction was a no-op or all retries exhausted. */
  summary:           string;
  /** Whether the final attempt succeeded — false means the caller should bail on compaction. */
  succeeded:         boolean;
  /** Diagnostic — number of attempts made. */
  attempts:          number;
}

/**
 * Run macrocompaction: format slice, call LLM, and retry after context overflow.
 * The caller validates the final context budget before persisting the summary.
 */
export async function runMacroCompaction(
  args: MacroCompactArgs,
): Promise<MacroCompactResult> {
  if (args.toCompact.length === 0) {
    return { summary: '', succeeded: false, attempts: 0 };
  }
  // Compaction always uses the current turn's model — same (providerId, model)
  // the user picked in the frontend picker. No separate binding needed.
  // If the history exceeds this model's context window, the truncate loop
  // below drops the oldest 20% each retry until it fits.
  const { providerId, model } = args;

  let toCompact = stripImages(args.toCompact);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const history = formatHistory(toCompact);
    const prompt  = buildCompactionPrompt({ mode: args.mode, history });

    // Pre-flight token estimate. If the prompt exceeds 85% of the model's
    // context window, truncate and retry rather than sending a known-overlimit
    // request.
    //
    // Strategy:
    //   attempt 1 — proportional cut: keep (threshold/estimated) fraction of
    //               messages, landing just under the threshold in one step.
    //               Handles large model switches (e.g. 1M → 200K) without
    //               burning multiple retry slots.
    //   attempt 2+ — small 20% cuts to correct for token-estimate imprecision.
    //   MIN_PRESERVE_MESSAGES reached while still over limit → bail immediately
    //               without calling the LLM (avoids a guaranteed PTL error).
    const estimated = estimateMessagesTokens([{ role: 'user', content: prompt }]);
    const threshold = Math.floor(args.modelContextWindow * COMPACTION_TRIGGER_RATIO);
    if (estimated > threshold) {
      if (toCompact.length <= MIN_PRESERVE_MESSAGES) {
        return { summary: '', succeeded: false, attempts: attempt };
      }
      if (attempt === 1) {
        const keepFraction = threshold / estimated;
        const keepCount    = Math.max(MIN_PRESERVE_MESSAGES, Math.floor(toCompact.length * keepFraction));
        toCompact = toCompact.slice(toCompact.length - keepCount);
      } else {
        toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
      }
      continue;
    }

    try {
      const remainingOutputTokens = Math.max(1, args.modelContextWindow - estimated);
      const desiredOutputTokens = Math.max(
        MIN_COMPACTION_OUTPUT,
        Math.floor(args.modelContextWindow * COMPACTION_OUTPUT_RATIO),
      );
      const completion = await args.llm.complete({
        providerId,
        model,
        messages:    [{ role: 'user', content: prompt }],
        maxTokens:   Math.min(desiredOutputTokens, remainingOutputTokens),
        temperature: 0.2,
        signal:      args.signal,
      });

      const summary = collectText(completion.blocks).trim();
      if (!summary) {
        return {
          summary: '',
          succeeded: false, attempts: attempt,
        };
      }

      return { summary, succeeded: true, attempts: attempt };

    } catch (err) {
      const reason = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isPTL = reason.includes('prompt') && (reason.includes('too long') || reason.includes('size'));
      const isOverflow = reason.includes('context') && reason.includes('length');
      const retryable = isPTL || isOverflow;
      if (!retryable || toCompact.length <= MIN_PRESERVE_MESSAGES) {
        return { summary: '', succeeded: false, attempts: attempt };
      }
      toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
    }
  }

  return { summary: '', succeeded: false, attempts: MAX_RETRIES };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateOldest(messages: ModelMessage[], fraction: number): ModelMessage[] {
  const drop = Math.max(1, Math.floor(messages.length * fraction));
  return messages.slice(drop);
}

function collectText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is AssistantBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text)
    .join('');
}
