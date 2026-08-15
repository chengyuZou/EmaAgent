import crypto from 'node:crypto';
import type { PendingFragmentsRepo } from '@ema-agent/storage';
import { estimateTextTokens } from '@ema-agent/token';
import type { PendingFragment } from './types.js';

// ── Read / write pending fragments ───────────────────────────────────────────

export function readPending(
  repo: PendingFragmentsRepo,
  sessionId: string,
): PendingFragment[] {
  return repo.listBySession(sessionId).map(row => ({
    turnId:  row.turn_id,
    role:    row.role,
    content: row.content,
    at:      row.at,
  }));
}

export function appendPending(
  repo: PendingFragmentsRepo,
  sessionId: string,
  fragment: PendingFragment,
  now: number,
): void {
  repo.insert({
    id:        crypto.randomUUID(),
    sessionId,
    turnId:    fragment.turnId,
    role:      fragment.role,
    content:   fragment.content,
    at:        fragment.at,
    createdAt: now,
  });
}

export function clearPending(
  repo: PendingFragmentsRepo,
  sessionId: string,
  _now: number,   // kept for call-site compat; DELETE doesn't need a timestamp
): void {
  repo.clearBySession(sessionId);
}

// ── Trigger evaluation ───────────────────────────────────────────────────────

/**
 * Should we fire an extraction task right now? Two thresholds:
 *   - token-primary  : pending fragment payload exceeds `tokenThreshold`
 *   - turn-secondary : raw turn count exceeds `turnThreshold` (safety net for
 *                      long sessions of low-density turns)
 *
 * Per-session "turn count since last extraction" is implicit —
 * we count distinct turnIds in the current pending buffer.
 */
export function shouldExtract(
  pending: PendingFragment[],
  thresholds: { tokenThreshold: number; turnThreshold: number },
): boolean {
  if (pending.length === 0) return false;

  let tokens = 0;
  const turnSet = new Set<string>();
  for (const f of pending) {
    tokens += estimateTextTokens(f.content);
    turnSet.add(f.turnId);
  }
  if (tokens >= thresholds.tokenThreshold)    return true;
  if (turnSet.size >= thresholds.turnThreshold) return true;
  return false;
}

// ── Fragment builders ────────────────────────────────────────────────────────

/**
 * Convert a raw turn's user input + assistant response text into pending
 * fragments. Skips empty content. Both roles are kept so the extraction LLM
 * can see Ema's perspective too ("I'll remember that you said X").
 */
export function buildFragmentsFromTurn(args: {
  turnId:        string;
  userText:      string;
  assistantText: string;
  at:            number;
}): PendingFragment[] {
  const out: PendingFragment[] = [];
  if (args.userText.trim()) {
    out.push({ turnId: args.turnId, role: 'user',      content: args.userText.trim(),      at: args.at });
  }
  if (args.assistantText.trim()) {
    out.push({ turnId: args.turnId, role: 'assistant', content: args.assistantText.trim(), at: args.at + 1 });
  }
  return out;
}
