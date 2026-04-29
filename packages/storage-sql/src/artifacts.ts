import type { Database } from "better-sqlite3";
import type {
  ArtifactRepository,
  ArtifactSummary,
  ArtifactDetail,
  ArtifactId,
  SessionId,
  RequestId,
  ArtifactStatus,
  ListArtifactsOptions,
  ArtifactPage
} from "@ema-agent/core-types";

// --- 辅助映射函数 ---

function rowToArtifactSummary(row: any): ArtifactSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    kind: row.kind,
    title: row.title,
    description: row.description || undefined,
    mime: row.mime,
    targetPaths: row.target_paths ? JSON.parse(row.target_paths) : undefined,
    params: row.params ? JSON.parse(row.params) : undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToArtifactDetail(row: any): ArtifactDetail {
  return {
    summary: rowToArtifactSummary(row),
    payload: {
      type: row.payload_type,
      // 还原 payload 结构: inline 存 content, file 存 path, db 存 key
      ...(row.payload_type === "inline" && { content: row.payload_content }),
      ...(row.payload_type === "file" && { path: row.payload_content }),
      ...(row.payload_type === "db" && { key: row.payload_content }),
    } as any, // 断言适配 ArtifactPayloadRef
    binaryBase64: row.binary_base64 || undefined,
    contentHash: row.content_hash || undefined,
  };
}

// --- 仓储工厂函数 ---

export function createArtifactRepository(db: Database): ArtifactRepository {
  return {
    async getById(id: ArtifactId): Promise<ArtifactDetail | null> {
      const row = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id);
      if (!row) return null;
      return rowToArtifactDetail(row);
    },

    async listBySession(sessionId: SessionId, options?: ListArtifactsOptions): Promise<ArtifactPage> {
      const limit = options?.limit ?? 20;
      let sql = `SELECT * FROM artifacts WHERE session_id = ?`;
      const params: any[] = [sessionId];

      if (options?.beforeCreatedAt) {
        sql += ` AND created_at < ?`;
        params.push(options.beforeCreatedAt);
      }

      if (options?.kinds && options.kinds.length > 0) {
        const placeholders = options.kinds.map(() => '?').join(',');
        sql += ` AND kind IN (${placeholders})`;
        params.push(...options.kinds);
      }

      if (options?.statuses && options.statuses.length > 0) {
        const placeholders = options.statuses.map(() => '?').join(',');
        sql += ` AND status IN (${placeholders})`;
        params.push(...options.statuses);
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit + 1); // 多查一条用于判断 hasMore

      const rows = db.prepare(sql).all(...params) as any[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(rowToArtifactSummary);

      return {
        items,
        hasMore,
        nextBeforeCreatedAt: hasMore ? items[items.length - 1].createdAt : undefined,
      };
    },

    async listByRequest(requestId: RequestId): Promise<ArtifactSummary[]> {
      const rows = db.prepare(`
        SELECT * FROM artifacts 
        WHERE request_id = ? 
        ORDER BY created_at ASC
      `).all(requestId);
      return rows.map(rowToArtifactSummary);
    },

    async create(summary: ArtifactSummary, content: string, binaryBase64?: string): Promise<ArtifactDetail> {
      const stmt = db.prepare(`
        INSERT INTO artifacts (
          id, session_id, request_id, kind, title, description, mime, 
          target_paths, params, status, 
          payload_type, payload_content, binary_base64, 
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 
          ?, ?, ?, 
          ?, ?, ?, 
          ?, ?
        )
      `);

      stmt.run(
        summary.id,
        summary.sessionId,
        summary.requestId,
        summary.kind,
        summary.title,
        summary.description || null,
        summary.mime,
        summary.targetPaths ? JSON.stringify(summary.targetPaths) : null,
        summary.params ? JSON.stringify(summary.params) : null,
        summary.status,
        "inline", // 这里简单起见默认新内容为 inline，如果涉及写盘可以扩展逻辑
        content,
        binaryBase64 || null,
        summary.createdAt,
        summary.updatedAt
      );

      return this.getById(summary.id) as Promise<ArtifactDetail>;
    },

    async updateStatus(id: ArtifactId, status: ArtifactStatus): Promise<void> {
      db.prepare(`
        UPDATE artifacts 
        SET status = ?, updated_at = ? 
        WHERE id = ?
      `).run(status, Date.now(), id);
    },

    async supersede(oldId: ArtifactId, newSummary: ArtifactSummary, newContent: string): Promise<ArtifactDetail> {
      // 这是一个典型的事务操作
      const transaction = db.transaction(() => {
        // 1. 废弃旧的
        db.prepare(`UPDATE artifacts SET status = 'superseded', updated_at = ? WHERE id = ?`)
          .run(Date.now(), oldId);
        
        // 2. 插入新的 (无法直接调用 this.create 因为它在事务外部)
        const stmt = db.prepare(`
          INSERT INTO artifacts (
            id, session_id, request_id, kind, title, description, mime, 
            target_paths, params, status, 
            payload_type, payload_content, 
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          newSummary.id,
          newSummary.sessionId,
          newSummary.requestId,
          newSummary.kind,
          newSummary.title,
          newSummary.description || null,
          newSummary.mime,
          newSummary.targetPaths ? JSON.stringify(newSummary.targetPaths) : null,
          newSummary.params ? JSON.stringify(newSummary.params) : null,
          newSummary.status,
          "inline",
          newContent,
          newSummary.createdAt,
          newSummary.updatedAt
        );
      });

      transaction();
      return this.getById(newSummary.id) as Promise<ArtifactDetail>;
    }
  };
}