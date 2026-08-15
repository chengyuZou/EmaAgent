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
import type { TurnStatus } from '@ema-agent/turn/turns';
import { parseMessageBlocksJson } from '../message.js';
import type {
  Message,
  Project,
  ProjectFolder,
  SearchSessionsOutput,
  Session,
  SessionListItem,
} from '../types.js';

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    workspaceRoot: row.workspace_root,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    pinned: row.pinned === 1,
    forkedFromSessionId: row.forked_from_session_id,
    forkedFromTurnId: row.forked_from_turn_id,
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    ProviderConfigId: row.provider_config_id,
    ModelId: row.model_id,
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

export function toMessage(row: MessageRow): Message {
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
    snippet: row.match_kind === 'title'
      ? row.title
      : blocksJsonToSearchText(row.snippet_json),
    messageId: row.message_id,
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
