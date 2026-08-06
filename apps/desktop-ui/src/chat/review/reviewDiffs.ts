// 从当前 Session 的工具结果 data 槽聚合真实文件变更(Edit/Write 携带 structuredPatch)。
// 聚合逻辑(按 callId 去重、倒序、最新 Turn 过滤)与数据源解耦;旧 presentation 通道已删。
import { useMemo } from 'react';
import type { TurnId } from '@ema-agent/ids';
import type { FileEditResult } from '@ema-agent/tool-builtin';
import { asFileEditResult } from '@ema-agent/tool-builtin/ui';
import { useConversationStore } from '../../stores/conversation-store.js';

export interface SessionDiff {
  callId: string;
  turnId?: TurnId;
  /** 完整事实: 展开单文件 diff 卡用。 */
  result: FileEditResult;
  additions: number;
  deletions: number;
}

const EMPTY_MESSAGES: never[] = [];

function countDelta(patch: FileEditResult['structuredPatch']): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

function toDiff(callId: string, turnId: TurnId | undefined, result: FileEditResult): SessionDiff {
  return { callId, turnId, result, ...countDelta(result.structuredPatch) };
}

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
        if (slice.type !== 'tool_use') continue;
        const fact = asFileEditResult(slice.result);
        if (fact) byCallId.set(slice.callId, toDiff(slice.callId, message.turnId, fact));
      }
    }
    for (const slice of streaming?.slices ?? []) {
      if (slice.type !== 'tool_use') continue;
      const fact = asFileEditResult(slice.result);
      if (fact) byCallId.set(slice.callId, toDiff(slice.callId, streaming?.turnId, fact));
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
