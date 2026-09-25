// 把 Storage 数据库行显式映射为 Session 领域对象和列表/搜索投影。
// Row 枚举（storage 自持）→ 领域词汇（turn 叶子）在此逐字段过界，恒等也写出来。
import type {
  MessageRow,
  ProjectFolderRow,
  ProjectRow,
  SessionRow,
  SessionRowEnriched,
  SessionSearchRow,
} from '@ema-agent/storage';
import type { TurnStatus } from '../types.js';
import { parseMessageBlocksJson } from '../message.js';
import type {
  SessionMessage,
  Project,
  ProjectFolder,
  SearchSessionsOutput,
  Session,
  SessionListItem,
} from '../types.js';

export function toProject(
  row: ProjectRow,
  folders: ProjectFolder[],
  sessions: SessionListItem[],
): Project {
  return {
    id: row.id,
    name: row.name,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    folders,
    sessions,
  };
}

export function toProjectFolder(row: ProjectFolderRow): ProjectFolder {
  return {
    path: row.path,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    pinned: row.pinned === 1,
    forkedFromSessionId: row.forked_from_session_id,
    forkedFromTurnId: row.forked_from_turn_id,
    sessionMode: row.session_mode,
    narrativePolicy: row.narrative_policy,
    permissionMode: row.permission_mode,
    ttsEnabled: row.tts_enabled === 1,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    lastViewedAt: row.last_viewed_at,
  };
}

/** 仅列表/搜索路径使用：投影三字段来自 enriched 行的 CTE 计算结果。 */
export function toSessionListItem(row: SessionRowEnriched): SessionListItem {
  const lastTurnStatus: TurnStatus | null = row.last_turn_status;
  return {
    ...toSession(row),
    hasActiveTurn: row.has_active_turn === 1,
    lastTurnStatus,
    hasUnread: row.last_activity_at > (row.last_viewed_at ?? 0),
  };
}

export function toMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id as string | null,
    role: row.role,
    kind: row.kind,
    blocks: parseMessageBlocksJson(row.blocks_json, row.role),
    interrupted: row.interrupted === 1,
    createdAt: row.created_at,
  };
}

export function toSearchHit(
  row: SessionSearchRow,
): SearchSessionsOutput['results'][number] {
  return {
    session: toSessionListItem(row),
    matchKind: row.match_kind,
    snippet: row.snippet_text ?? '',
    anchorMessageId: row.message_id,
    messageAt: row.message_created_at,
  };
}
