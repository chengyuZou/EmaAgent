// 从当前 Session 的工具结果中提取可恢复的真实文件变更。
import { useMemo } from 'react';
import type { TurnId } from '@ema-agent/ids';
import type { FileChangePresentation } from '@ema-agent/turn';
import { useConversationStore } from '../../stores/conversation-store.js';

export interface SessionDiff {
  callId: string;
  turnId?: TurnId;
  change: FileChangePresentation;
}

const EMPTY_MESSAGES: never[] = [];

export function useSessionDiffs(sessionId: string | null): SessionDiff[] {
  const messages = useConversationStore((state) => (
    sessionId ? state.messages.get(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  ));
  const streaming = useConversationStore((state) => (
    sessionId ? state.streamingMap.get(sessionId) : undefined
  ));

  return useMemo(() => {
    const byCallId = new Map<string, SessionDiff>();
    for (const message of messages) {
      for (const slice of message.slices ?? []) {
        if (slice.type !== 'tool_use' || slice.presentation?.kind !== 'file_change') continue;
        byCallId.set(slice.callId, {
          callId: slice.callId,
          turnId: message.turnId,
          change: slice.presentation,
        });
      }
    }
    for (const slice of streaming?.slices ?? []) {
      if (slice.type !== 'tool_use' || slice.presentation?.kind !== 'file_change') continue;
      byCallId.set(slice.callId, {
        callId: slice.callId,
        turnId: streaming?.turnId,
        change: slice.presentation,
      });
    }
    return [...byCallId.values()].reverse();
  }, [messages, streaming]);
}

export function useLatestTurnDiffs(sessionId: string | null): SessionDiff[] {
  const diffs = useSessionDiffs(sessionId);
  return useMemo(() => {
    const latestTurnId = diffs.find((diff) => diff.turnId)?.turnId;
    if (!latestTurnId) return diffs;
    return diffs.filter((diff) => diff.turnId === latestTurnId);
  }, [diffs]);
}
