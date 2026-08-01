// 把 Storage 数据库行转换为 Session 领域对象和搜索投影。

import type { MessageId, SessionId, TurnId } from '@ema-agent/ids';
import type {
  MessageRow,
  SessionRow,
  SessionRowEnriched,
  SessionSearchRow,
  TurnRow,
} from '@ema-agent/storage';
import { parseMessageBlocksJson } from '../message.js';
import type {
  Message,
  SearchSessionsOutput,
  Session,
  Turn,
} from '../types.js';

export function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    workspaceRoot: row.workspace_root ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at,
    groupLabel: row.group_label,
    parentSessionId: row.parent_session_id as SessionId | null,
    runningTurnCount: 0,
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    preferredProviderConfigId: row.preferred_provider_config_id ?? null,
    preferredModelId: row.preferred_model_id ?? null,
    lastViewedAt: row.last_viewed_at ?? null,
    lastTurnStatus: null,
    hasUnread: false,
  };
}

export function toSessionEnriched(row: SessionRowEnriched): Session {
  const session = toSession(row);
  const lastTurnStatus = (row.last_turn_status ?? null) as Session['lastTurnStatus'];
  const lastTurnCompletedAt = row.last_turn_completed_at ?? 0;
  return {
    ...session,
    runningTurnCount: row.running_turn_count,
    lastTurnStatus,
    hasUnread: lastTurnStatus === 'completed'
      && lastTurnCompletedAt > (row.last_viewed_at ?? 0),
  };
}

export function toTurn(row: TurnRow): Turn {
  return {
    id: row.id as TurnId,
    sessionId: row.session_id as SessionId,
    triggerType: row.trigger_type,
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    status: row.status,
    userInput: row.user_input,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    iterations: row.iterations,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id as MessageId,
    sessionId: row.session_id as SessionId,
    turnId: row.turn_id as TurnId | null,
    role: row.role,
    kind: row.kind,
    blocks: parseMessageBlocksJson(row.blocks_json, row.role, row.kind),
    interrupted: row.interrupted === 1,
    createdAt: row.created_at,
  };
}

export function toSearchHit(
  row: SessionSearchRow,
): SearchSessionsOutput['results'][number] {
  return {
    session: toSessionEnriched(row),
    matchKind: row.match_kind,
    snippet: row.match_kind === 'title'
      ? row.title
      : blocksJsonToSearchText(row.snippet_json),
    messageId: row.message_id as MessageId | null,
    messageAt: row.message_created_at,
  };
}

function blocksJsonToSearchText(raw: string | null): string {
  if (!raw) return '';
  try {
    const blocks: unknown = JSON.parse(raw);
    if (typeof blocks === 'string') return normaliseSnippet(blocks);
    if (!Array.isArray(blocks)) return '';

    const parts: string[] = [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'tool_result' && typeof block.content === 'string') {
        parts.push(block.content);
      }
    }
    return normaliseSnippet(parts.join(' '));
  } catch {
    return normaliseSnippet(raw);
  }
}

function normaliseSnippet(text: string): string {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
