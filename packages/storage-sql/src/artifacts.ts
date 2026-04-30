/**
 * Artifact 仓储实现 —— 纯 SQLite。
 *
 * Repository 接口定义在本文件内部，不依赖 core-types 导出（已移除）。
 * 实体类型从 @ema-agent/core-types 导入。
 */

import type { Database } from "better-sqlite3";
import type {
  ArtifactSummary,
  ArtifactDetail,
  ArtifactPayloadRef,
  ArtifactKind,
  ArtifactStatus,
  ArtifactParams,
  ArtifactPage,
  ListArtifactsOptions,
  ArtifactId,
  SessionId,
  RequestId,
} from "@ema-agent/core-types";

// ==========================================
// ArtifactRepository 接口（storage-sql 内部契约）
// ==========================================

export interface ArtifactRepository {
  createArtifact(input: CreateArtifactInput): Promise<ArtifactSummary>;
  getArtifactById(artifactId: ArtifactId): Promise<ArtifactDetail | null>;
  updateArtifact(input: UpdateArtifactInput): Promise<void>;
  listArtifactsBySession(sessionId: SessionId, options?: ListArtifactsOptions): Promise<ArtifactPage>;
  listArtifactsByRequest(requestId: RequestId): Promise<ArtifactSummary[]>;
  deleteArtifact(artifactId: ArtifactId): Promise<void>;
}

export interface CreateArtifactInput {
  id: ArtifactId;
  sessionId: SessionId;
  requestId: RequestId;
  kind: ArtifactKind;
  title: string;
  description?: string;
  mime?: string;
  targetPaths?: string[];
  params?: ArtifactParams;
  status?: ArtifactStatus;
  payloadType?: "inline" | "file" | "db";
  payloadContent?: string;
  binaryBase64?: string;
  contentHash?: string;
  createdAt?: number;
}

export interface UpdateArtifactInput {
  artifactId: ArtifactId;
  title?: string;
  description?: string;
  mime?: string;
  targetPaths?: string[];
  params?: ArtifactParams;
  status?: ArtifactStatus;
  payloadType?: "inline" | "file" | "db";
  payloadContent?: string;
  binaryBase64?: string;
  contentHash?: string;
}

// ==========================================
// Row → Entity 映射
// ==========================================

function rowToSummary(row: any): ArtifactSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    description: row.description ?? undefined,
    mime: row.mime,
    targetPaths: row.target_paths ? JSON.parse(row.target_paths) : undefined,
    params: row.params ? (JSON.parse(row.params) as ArtifactParams) : undefined,
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDetail(row: any): ArtifactDetail {
  const payload: ArtifactPayloadRef =
    row.payload_type === "file"
      ? { type: "file", path: row.payload_content ?? "" }
      : row.payload_type === "db"
        ? { type: "db", key: row.payload_content ?? "" }
        : { type: "inline", content: row.payload_content ?? "" };

  return {
    summary: rowToSummary(row),
    payload,
    binaryBase64: row.binary_base64 ?? undefined,
    contentHash: row.content_hash ?? undefined,
  };
}

// ==========================================
// 工厂函数
// ==========================================

export function createArtifactRepository(db: Database): ArtifactRepository {
  return {
    async createArtifact(input: CreateArtifactInput) {
      const now = input.createdAt ?? Date.now();

      db.prepare(`
        INSERT INTO artifacts (
          id, session_id, request_id, kind, title, description, mime,
          target_paths, params, status, payload_type, payload_content,
          binary_base64, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.requestId,
        input.kind,
        input.title,
        input.description ?? null,
        input.mime ?? "text/plain",
        input.targetPaths ? JSON.stringify(input.targetPaths) : null,
        input.params ? JSON.stringify(input.params) : null,
        input.status ?? "draft",
        input.payloadType ?? "inline",
        input.payloadContent ?? null,
        input.binaryBase64 ?? null,
        input.contentHash ?? null,
        now,
        now,
      );

      const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(input.id);
      return rowToSummary(row);
    },

    async getArtifactById(artifactId: ArtifactId) {
      const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(artifactId);
      return row ? rowToDetail(row) : null;
    },

    async updateArtifact(input: UpdateArtifactInput) {
      const updates: string[] = [];
      const values: any[] = [];

      if (input.title !== undefined) { updates.push("title = ?"); values.push(input.title); }
      if (input.description !== undefined) { updates.push("description = ?"); values.push(input.description); }
      if (input.mime !== undefined) { updates.push("mime = ?"); values.push(input.mime); }
      if (input.targetPaths !== undefined) {
        updates.push("target_paths = ?");
        values.push(input.targetPaths ? JSON.stringify(input.targetPaths) : null);
      }
      if (input.params !== undefined) {
        updates.push("params = ?");
        values.push(input.params ? JSON.stringify(input.params) : null);
      }
      if (input.status !== undefined) { updates.push("status = ?"); values.push(input.status); }
      if (input.payloadType !== undefined) { updates.push("payload_type = ?"); values.push(input.payloadType); }
      if (input.payloadContent !== undefined) { updates.push("payload_content = ?"); values.push(input.payloadContent); }
      if (input.binaryBase64 !== undefined) { updates.push("binary_base64 = ?"); values.push(input.binaryBase64); }
      if (input.contentHash !== undefined) { updates.push("content_hash = ?"); values.push(input.contentHash); }

      if (updates.length === 0) return;

      updates.push("updated_at = ?");
      values.push(Date.now());
      values.push(input.artifactId);

      const sql = `UPDATE artifacts SET ${updates.join(", ")} WHERE id = ?`;
      db.prepare(sql).run(...values);
    },

    async listArtifactsBySession(sessionId: SessionId, options?: ListArtifactsOptions) {
      const limit = options?.limit ?? 20;
      let sql = `SELECT * FROM artifacts WHERE session_id = ?`;
      const params: any[] = [sessionId];

      if (options?.beforeCreatedAt) {
        sql += ` AND created_at < ?`;
        params.push(options.beforeCreatedAt);
      }

      if (options?.kinds && options.kinds.length > 0) {
        sql += ` AND kind IN (${options.kinds.map(() => '?').join(',')})`;
        params.push(...options.kinds);
      }

      if (options?.statuses && options.statuses.length > 0) {
        sql += ` AND status IN (${options.statuses.map(() => '?').join(',')})`;
        params.push(...options.statuses);
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit + 1);

      const rows = db.prepare(sql).all(...params) as any[];
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return {
        items: items.map(rowToSummary),
        hasMore,
        nextBeforeCreatedAt: hasMore ? items[items.length - 1].created_at : undefined,
      };
    },

    async listArtifactsByRequest(requestId: RequestId) {
      const rows = db.prepare(`
        SELECT * FROM artifacts WHERE request_id = ? ORDER BY created_at ASC
      `).all(requestId) as any[];
      return rows.map(rowToSummary);
    },

    async deleteArtifact(artifactId: ArtifactId) {
      db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(artifactId);
    },
  };
}