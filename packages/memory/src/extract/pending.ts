import type { SessionId, TurnId } from '@ema-agent/contracts';
import type { SessionsRepo } from '@ema-agent/storage';
import { estimateTextTokens } from '../tokens/estimate.js';
import type { PendingFragment } from './types.js';

// ── Read / write pending fragments buffer ────────────────────────────────────

function parse(json: string): PendingFragment[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as PendingFragment[]) : [];
  } catch {
    return [];
  }
}

export function readPending(repo: SessionsRepo, sessionId: SessionId): PendingFragment[] {
  return parse(repo.getPendingFragmentsRaw(sessionId));
}

export function appendPending(
  repo: SessionsRepo,
  sessionId: SessionId,
  fragment: PendingFragment,
  now: number,
): PendingFragment[] {
  const arr = readPending(repo, sessionId);
  arr.push(fragment);
  repo.setPendingFragmentsRaw(sessionId, JSON.stringify(arr), now);
  return arr;
}

export function clearPending(
  repo: SessionsRepo,
  sessionId: SessionId,
  now: number,
): void {
  repo.clearPendingFragments(sessionId, now);
}

// ── Trigger evaluation ───────────────────────────────────────────────────────

/**
 * Should we fire an extraction task right now? Two thresholds:
 *   - token-primary  : pending fragment payload exceeds `tokenThreshold`
 *   - turn-secondary : raw turn count exceeds `turnThreshold` (safety net for
 *                      long sessions of low-density turns)
 *
 * Per-session storage of "turn count since last extraction" is implicit —
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
  if (tokens >= thresholds.tokenThreshold)   return true;
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
  turnId:      TurnId;
  userText:    string;
  assistantText: string;
  at:          number;
}): PendingFragment[] {
  const out: PendingFragment[] = [];
  if (args.userText.trim()) {
    out.push({ turnId: args.turnId, role: 'user',      content: args.userText.trim(),    at: args.at });
  }
  if (args.assistantText.trim()) {
    out.push({ turnId: args.turnId, role: 'assistant', content: args.assistantText.trim(), at: args.at + 1 });
  }
  return out;
}
