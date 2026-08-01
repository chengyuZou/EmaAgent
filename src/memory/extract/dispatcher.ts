import type { ExecutionProfile } from '@ema-agent/turn';
import type { SessionId } from '@ema-agent/ids';
import { bestEffort } from '../best-effort.js';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings } from '../types.js';
import type { MemoryTaskRunner } from '../tasks/extraction-runner.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';
import { appendPending, readPending, shouldExtract, buildFragmentsFromTurn } from './pending.js';

/** 把已完成 Turn 的可见文本写入待提取区，并在达到阈值时安排提取。 */
export async function recordTurnForExtraction(
  deps:                MemoryDeps,
  settings:            MemorySettings,
  runner:              MemoryTaskRunner,
  getSessionOverrides: (sessionId: SessionId) => ResolvedSessionOverrides,
  ctx: {
    sessionId:     SessionId;
    turnId:        string;
    executionProfile: ExecutionProfile;
    userText:      string;
    assistantText: string;
  },
): Promise<void> {
  if (!settings.enabled) return;

  const overrides = getSessionOverrides(ctx.sessionId);
  if (!overrides.extraction) return;

  const fragments = buildFragmentsFromTurn({
    turnId:        ctx.turnId as never,
    userText:      ctx.userText,
    assistantText: ctx.assistantText,
    at:            Date.now(),
  });

  bestEffort('appendPending', () => {
    for (const f of fragments) {
      appendPending(deps.pendingFragments, ctx.sessionId, f, Date.now());
    }
  }, undefined);

  const pending = bestEffort('readPending',
    () => readPending(deps.pendingFragments, ctx.sessionId), null);
  if (pending === null) return;
  if (!shouldExtract(pending, {
    tokenThreshold: settings.triggers.pendingTokenThreshold,
    turnThreshold:  settings.triggers.pendingTurnThreshold,
  })) return;

  bestEffort('enqueue extraction', () => {
    runner.enqueue('extraction', ctx.sessionId, {
      sessionId: ctx.sessionId,
      executionProfile: ctx.executionProfile,
    });
  }, undefined);
}

export async function handleForceExtract(
  runner:    MemoryTaskRunner,
  sessionId: SessionId,
  executionProfile: ExecutionProfile,
): Promise<void> {
  bestEffort('forceExtract enqueue', () => {
    runner.enqueue('extraction', sessionId, { sessionId, executionProfile });
  }, undefined);
}
