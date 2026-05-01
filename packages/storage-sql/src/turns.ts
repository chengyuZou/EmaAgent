/**
 * Turn 仓储实现 —— 纯 SQLite。
 *
 * Repository 接口定义在本文件内部，不依赖 core-types 导出（已移除）。
 * 实体类型从 @ema-agent/core-types 导入。
 */

import type { Database } from "better-sqlite3";
import type {
  TurnRecord,
  UsageView,
  EmaMode,
  TurnStatus,
  RequestId,
  SessionId,
  ModelId,
  ProviderId,
  UnixMs,
} from "@ema-agent/core-types";

// ==========================================
// 本地 DTO（不暴露到 core-types）
// ==========================================

export interface CreateTurnInput {
  requestId: RequestId;
  sessionId: SessionId;
  mode: EmaMode;
  status?: TurnStatus;
  modelId?: ModelId;
  providerId?: ProviderId;
  startedAt?: UnixMs;
}

export interface UpdateTurnInput {
  requestId: RequestId;
  status?: TurnStatus;
  modelId?: ModelId;
  providerId?: ProviderId;
  endedAt?: UnixMs;
  usage?: UsageView;
  errorCode?: string;
  errorMessage?: string;
}

export interface ListTurnsOptions {
  limit?: number;
  beforeStartedAt?: UnixMs;
  beforeRequestId?: RequestId;
}

export interface TurnPage {
  items: TurnRecord[];
  hasMore: boolean;
  nextBeforeStartedAt?: UnixMs;
  nextBeforeRequestId?: RequestId;
}

// ==========================================
// TurnRepository 接口（storage-sql 内部契约）
// ==========================================

export interface TurnRepository {
  createTurn(input: CreateTurnInput): Promise<TurnRecord>;
  getTurnById(requestId: RequestId): Promise<TurnRecord | null>;
  updateTurn(input: UpdateTurnInput): Promise<void>;
  listTurnsBySession(sessionId: SessionId, options?: ListTurnsOptions): Promise<TurnPage>;
}

// ==========================================
// Row → Entity 映射
// ==========================================

function rowToTurn(row: any): TurnRecord {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    mode: row.mode as EmaMode,
    status: row.status as TurnStatus,
    modelId: row.model_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    usage: row.usage_json ? (JSON.parse(row.usage_json) as UsageView) : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

// ==========================================
// 工厂函数
// ==========================================

export function createTurnRepository(db: Database): TurnRepository {
  return {
    async createTurn(input: CreateTurnInput): Promise<TurnRecord> {
      const startedAt = input.startedAt ?? Date.now();
      const status = input.status ?? "queued";

      db.prepare(`
        INSERT INTO turns (
          request_id, session_id, mode, status, model_id, provider_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.requestId,
        input.sessionId,
        input.mode,
        status,
        input.modelId ?? null,
        input.providerId ?? null,
        startedAt,
      );

      return this.getTurnById(input.requestId) as Promise<TurnRecord>;
    },

    async getTurnById(requestId: RequestId): Promise<TurnRecord | null> {
      const row = db.prepare(`SELECT * FROM turns WHERE request_id = ?`).get(requestId);
      if (!row) return null;
      return rowToTurn(row);
    },

    async updateTurn(input: UpdateTurnInput): Promise<void> {
      const updates: string[] = [];
      const values: any[] = [];

      if (input.status !== undefined) {
        updates.push("status = ?");
        values.push(input.status);
      }
      if (input.modelId !== undefined) {
        updates.push("model_id = ?");
        values.push(input.modelId);
      }
      if (input.providerId !== undefined) {
        updates.push("provider_id = ?");
        values.push(input.providerId);
      }
      if (input.endedAt !== undefined) {
        updates.push("ended_at = ?");
        values.push(input.endedAt);
      }
      if (input.usage !== undefined) {
        updates.push("usage_json = ?");
        values.push(JSON.stringify(input.usage));
      }
      if (input.errorCode !== undefined) {
        updates.push("error_code = ?");
        values.push(input.errorCode);
      }
      if (input.errorMessage !== undefined) {
        updates.push("error_message = ?");
        values.push(input.errorMessage);
      }

      if (updates.length === 0) return;

      values.push(input.requestId);
      const sql = `UPDATE turns SET ${updates.join(", ")} WHERE request_id = ?`;
      db.prepare(sql).run(...values);
    },

    async listTurnsBySession(sessionId: SessionId, options?: ListTurnsOptions): Promise<TurnPage> {
      const limit = options?.limit ?? 20;
      let sql = `SELECT * FROM turns WHERE session_id = ?`;
      const params: any[] = [sessionId];

      if (options?.beforeStartedAt) {
        if (options.beforeRequestId) {
          sql += ` AND (started_at < ? OR (started_at = ? AND request_id < ?))`;
          params.push(options.beforeStartedAt, options.beforeStartedAt, options.beforeRequestId);
        } else {
          sql += ` AND started_at < ?`;
          params.push(options.beforeStartedAt);
        }
      }

      sql += ` ORDER BY started_at DESC, request_id DESC LIMIT ?`;
      params.push(limit + 1);

      const rows = db.prepare(sql).all(...params) as any[];
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const records = items.map(rowToTurn);

      return {
        items: records,
        hasMore,
        nextBeforeStartedAt: hasMore ? records[records.length - 1].startedAt : undefined,
        nextBeforeRequestId: hasMore ? records[records.length - 1].requestId : undefined,
      };
    },
  };
}
