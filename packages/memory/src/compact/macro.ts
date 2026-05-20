import crypto from 'node:crypto';
import type { LlmRouter, LlmMessage, AssistantBlock, UserBlock } from '@ema-agent/llm';
import type { ModelBindingsRepo } from '@ema-agent/storage';
import type { TurnMode, SessionId, TurnId, MessageBlocks } from '@ema-agent/contracts';
import type { SessionStore } from '@ema-agent/session';
import { buildCompactionPrompt } from './prompts.js';
import { estimateMessagesTokens } from '../tokens/estimate.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TRUNCATE_FRACTION = 0.2;   // each retry drops the oldest 20%
const MIN_PRESERVE_MESSAGES = 4; // never compact below this many tail messages

// ── Resolve compaction LLM binding ───────────────────────────────────────────

interface BindingRef {
  providerId: string;
  model:      string;
}

function resolveCompactionBinding(
  llm: LlmRouter,
  modelBindings: ModelBindingsRepo,
): BindingRef | null {
  // 'memory' binding doubles for compaction in V1 — same cheap model serves both.
  const memBinding = modelBindings.get('memory') ?? modelBindings.get('compaction');
  if (memBinding) {
    return { providerId: memBinding.providerConfigId, model: memBinding.model };
  }
  const providerId = llm.firstProviderId();
  if (!providerId) return null;
  const model = llm.defaultModelFor(providerId);
  if (!model) return null;
  return { providerId, model };
}

// ── Slice formatting (for the LLM input) ─────────────────────────────────────

function formatHistory(messages: LlmMessage[]): string {
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
    case 'thinking':     return `<thinking>${(blk as { thinking: string }).thinking}</thinking>`;
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

function stripImages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const next: UserBlock[] = msg.content.map((blk) => {
        const t = (blk as { type?: string }).type;
        if (t === 'image_url' || t === 'image_data' || t === 'audio_data'
            || t === 'file_url' || t === 'file_data') {
          return { type: 'text', text: `[${t}]` };
        }
        return blk;
      });
      return { role: 'user', content: next };
    }
    return msg;
  });
}

// ── Macrocompaction core ─────────────────────────────────────────────────────

export interface MacroCompactArgs {
  llm:           LlmRouter;
  modelBindings: ModelBindingsRepo;
  session:       SessionStore;
  sessionId:     SessionId;
  turnId:        TurnId;
  mode:          TurnMode;
  /** Messages to summarise (older portion). */
  toCompact:     LlmMessage[];
  /**
   * Token limit we MUST land below. When the summariser itself trips PTL we
   * retry with a truncated head (oldest 20% dropped) up to MAX_RETRIES.
   */
  modelContextWindow: number;
  signal?:       AbortSignal;
}

export interface MacroCompactResult {
  /** Compacted summary text. Empty string when compaction was a no-op or all retries exhausted. */
  summary:           string;
  /** New `kind: 'summary'` message persisted to DB, or null when failed. */
  summaryMessageId:  string | null;
  /** Whether the final attempt succeeded — false means the caller should bail on compaction. */
  succeeded:         boolean;
  /** Diagnostic — number of attempts made. */
  attempts:          number;
}

/**
 * Run macrocompaction: format slice, call LLM, retry-on-PTL, persist summary.
 *
 * Persistence: writes a single message with `kind: 'summary'` whose blocks
 * contain the summary text. This row doubles as the compaction boundary —
 * SessionStore.loadHistory() begins from this row on the next turn.
 */
export async function runMacroCompaction(
  args: MacroCompactArgs,
): Promise<MacroCompactResult> {
  if (args.toCompact.length === 0) {
    return { summary: '', summaryMessageId: null, succeeded: false, attempts: 0 };
  }
  const binding = resolveCompactionBinding(args.llm, args.modelBindings);
  if (!binding) {
    return { summary: '', summaryMessageId: null, succeeded: false, attempts: 0 };
  }

  let toCompact = stripImages(args.toCompact);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const history = formatHistory(toCompact);
    const prompt  = buildCompactionPrompt({ mode: args.mode, history });

    // Sanity check: pre-flight token estimate. Bail to truncation early if huge.
    const estimated = estimateMessagesTokens([{ role: 'user', content: prompt }]);
    const safeBudget = Math.max(8000, args.modelContextWindow - 4000);
    if (estimated > safeBudget && toCompact.length > MIN_PRESERVE_MESSAGES) {
      toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
      continue;
    }

    try {
      const completion = await args.llm.complete({
        providerId:  binding.providerId,
        model:       binding.model,
        messages:    [{ role: 'user', content: prompt }],
        maxTokens:   3000,
        temperature: 0.2,
        signal:      args.signal,
      });

      const summary = collectText(completion.blocks).trim();
      if (!summary) {
        return {
          summary: '', summaryMessageId: null,
          succeeded: false, attempts: attempt,
        };
      }

      const msgId = persistSummary(args.session, args.sessionId, args.turnId, summary);
      return { summary, summaryMessageId: msgId, succeeded: true, attempts: attempt };

    } catch (err) {
      const reason = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isPTL = reason.includes('prompt') && (reason.includes('too long') || reason.includes('size'));
      const isOverflow = reason.includes('context') && reason.includes('length');
      const retryable = isPTL || isOverflow;
      if (!retryable || toCompact.length <= MIN_PRESERVE_MESSAGES) {
        return { summary: '', summaryMessageId: null, succeeded: false, attempts: attempt };
      }
      toCompact = truncateOldest(toCompact, TRUNCATE_FRACTION);
    }
  }

  return { summary: '', summaryMessageId: null, succeeded: false, attempts: MAX_RETRIES };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateOldest(messages: LlmMessage[], fraction: number): LlmMessage[] {
  const drop = Math.max(1, Math.floor(messages.length * fraction));
  return messages.slice(drop);
}

function collectText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is AssistantBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function persistSummary(
  session: SessionStore,
  sessionId: SessionId,
  turnId: TurnId,
  summary: string,
): string {
  const id = crypto.randomUUID();
  const msg = session.appendMessage({
    turnId,
    sessionId,
    role:  'user',
    kind:  'summary',
    blocks: summary satisfies MessageBlocks,
  });
  // appendMessage returns its own id (uuid); we relay it for telemetry
  void id;
  return msg.id;
}
