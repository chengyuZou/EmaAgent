// 从当前 Session 的工具结果 data 槽聚合真实文件变更(Edit/Write 携带 structuredPatch)。
// 聚合逻辑(按 callId 去重、倒序、最新 Turn 过滤)与数据源解耦;旧 presentation 通道已删。
import { useMemo } from 'react';

import {
  additionsToUnifiedText,
  asFileEditResult,
  asFileWriteResult,
  patchToUnifiedText,
} from '@ema-agent/builtin-tools/ui';
import { useConversationStore } from '../../stores/conversation-store.js';

export interface SessionDiff {
  callId: string;
  turnId?: string;
  filePath: string;
  status: 'created' | 'modified';
  additions: number;
  deletions: number;
  /** Review 面板 DiffCard 的展示输入;created 形态由 content 合成全新增。 */
  unifiedDiff: string;
}

const EMPTY_MESSAGES: never[] = [];

interface ParsedHunks {
  readonly lines: readonly string[];
}

function countLines(patch: readonly ParsedHunks[]): { additions: number; deletions: number } {
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

/** 依次试 Edit/Write 守卫;都不是(其他工具/错误结果/旧消息)返回 null。 */
function toSessionDiff(
  callId: string,
  turnId: string | undefined,
  data: unknown,
): SessionDiff | null {
  const edit = asFileEditResult(data);
  if (edit) {
    return {
      callId,
      turnId,
      filePath: edit.filePath,
      status: 'modified',
      ...countLines(edit.structuredPatch),
      unifiedDiff: patchToUnifiedText(edit.structuredPatch),
    };
  }
  const write = asFileWriteResult(data);
  if (write) {
    if (write.type === 'created') {
      const lineCount = write.content.split('\n').length
        - (write.content.endsWith('\n') ? 1 : 0);
      return {
        callId,
        turnId,
        filePath: write.filePath,
        status: 'created',
        additions: lineCount,
        deletions: 0,
        unifiedDiff: additionsToUnifiedText(write.content),
      };
    }
    return {
      callId,
      turnId,
      filePath: write.filePath,
      status: 'modified',
      ...countLines(write.structuredPatch),
      unifiedDiff: patchToUnifiedText(write.structuredPatch),
    };
  }
  return null;
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
        const diff = toSessionDiff(slice.callId, message.turnId, slice.result);
        if (diff) byCallId.set(slice.callId, diff);
      }
    }
    for (const slice of streaming?.slices ?? []) {
      if (slice.type !== 'tool_use') continue;
      const diff = toSessionDiff(slice.callId, streaming?.turnId, slice.result);
      if (diff) byCallId.set(slice.callId, diff);
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
