import type { ExecutionProfile } from '@ema-agent/turn-terms';
import { estimateTextTokens } from '@ema-agent/token';
import { buildNoteCompactionPrompt } from '@ema-agent/context';
import { extractCompactionSummary } from '@ema-agent/context';
import type { SessionNoteEntry } from './types.js';
import { safeParseEntries } from './types.js';
import type { ExtractionPipelineDeps } from './pipeline.js';

/**
 * L1 摘要的溯源是固有的：session_id 即主键，每条 entry 携带产生它的 turnId，
 * 不需要 L0 那样的关联表。
 */
export function appendSessionNote(
  deps: ExtractionPipelineDeps,
  sessionId: string,
  delta: string,
  turnId: string,
): void {
  const existing = deps.memory.sessionNotes.findBySession(sessionId);
  const now = Date.now();

  const entries: SessionNoteEntry[] = existing?.body
    ? safeParseEntries(existing.body)
    : [];
  entries.push({ at: now, turnId, delta: delta.trim() });
  const body = JSON.stringify(entries);
  deps.memory.sessionNotes.upsert({
    sessionId,
    body,
    tokensAtLastUpdate: estimateTextTokens(entries.map(e => e.delta).join('\n')),
    updatedAt:          now,
  });
}

export async function compactSessionNoteIfNeeded(
  deps: ExtractionPipelineDeps,
  sessionId: string,
  executionProfile: ExecutionProfile,
  signal?: AbortSignal,
  assertWritable?: () => void,
): Promise<void> {
  const row = deps.memory.sessionNotes.findBySession(sessionId);
  if (!row) return;

  const entries = safeParseEntries(row.body);
  if (entries.length === 0) return;

  const totalTokens = estimateTextTokens(entries.map(e => e.delta).join('\n'));
  if (totalTokens <= deps.settings.recall.layer1MaxTokens) return;

  const expiryDays = deps.settings.recall.layer1EntryExpiryDays;
  const keepRecent = deps.settings.recall.layer1KeepRecentEntries;

  const cutoff = Date.now() - expiryDays * 86400_000;

  const fresh = entries.filter(e => e.at > cutoff);

  if (fresh.length === 0) {
    assertWritable?.();
    deps.memory.sessionNotes.upsert({
      sessionId,
      body:               JSON.stringify([]),
      tokensAtLastUpdate: 0,
      updatedAt:          Date.now(),
    });
    return;
  }

  const tail    = fresh.slice(-keepRecent);
  const toMerge = fresh.slice(0, -keepRecent);

  if (toMerge.length === 0) return;

  const binding = resolveMemoryBindingLocal(deps);
  if (!binding) return;

  const mergeText = toMerge.map(e => e.delta).join('\n\n');
  const prompt = buildNoteCompactionPrompt({
    executionProfile,
    body: mergeText,
  });
  const completion = await deps.memory.llm.complete({
    providerId: binding.providerId,
    model: binding.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 800,
    temperature: 0.2,
    signal,
  });
  const mergedOutput = completion.blocks
    .filter((b): b is typeof b & { type: 'text' } => b.type === 'text')
    .map(b => b.text).join('').trim();
  const merged = extractCompactionSummary(mergedOutput);

  if (!merged) return;

  const mergedEntry: SessionNoteEntry = {
    at:     toMerge[0]!.at,
    turnId: 'compacted',
    delta:  merged,
  };
  const compacted = [mergedEntry, ...tail];

  // LLM 调用期间任务租约可能易主；真正写入前必须重新确认所有权。
  assertWritable?.();
  const now = Date.now();
  deps.memory.sessionNotes.upsert({
    sessionId,
    body: JSON.stringify(compacted),
    tokensAtLastUpdate: estimateTextTokens(compacted.map(e => e.delta).join('\n')),
    updatedAt: now,
  });
}

export function resolveMemoryBindingLocal(
  deps: ExtractionPipelineDeps,
): { providerId: string; model: string } | null {
  const binding = deps.memory.modelBindings.get('memory-llm');
  return binding
    ? { providerId: binding.providerConfigId, model: binding.model }
    : null;
}
