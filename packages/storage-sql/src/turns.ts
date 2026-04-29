// src/turns.ts
import type { Database } from "better-sqlite3";
import type {
  TurnRepository,
  TurnRecord,
  CreateTurnInput,
  UpdateTurnInput,
  ListTurnsOptions,
  TurnPage,
  UsageView,
  EmaMode,
  TurnStatus
} from "@ema-agent/core-types";

// ==========================================
// 1. 纯函数映射区 (Row -> Entity)
// ==========================================

/**
 * 数据库行数据映射为 TypeScript 强类型实体。
 * 这里隔离了数据库的下划线命名 (snake_case) 和前端的驼峰命名 (camelCase)。
 */
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
    // 从数据库拿出来的 JSON 字符串，需要 Parse 回对象
    usage: row.usage_json ? (JSON.parse(row.usage_json) as UsageView) : undefined,
  };
}

// ==========================================
// 2. 仓储层实现区
// ==========================================

/**
 * 工厂函数：注入 db 依赖，返回实现了 TurnRepository 接口的对象。
 */
export function createTurnRepository(db: Database): TurnRepository {
  return {
    
    // ----------------------------------------
    // 创建一条 Turn 记录
    // ----------------------------------------
    async createTurn(input: CreateTurnInput): Promise<TurnRecord> {
      // 1. 准备 SQL 语句
      const stmt = db.prepare(`
        INSERT INTO turns (
          request_id, session_id, mode, status, model_id, provider_id, started_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?
        )
      `);

      // 2. 填充默认值
      const startedAt = input.startedAt ?? Date.now();
      const status = input.status ?? "queued";

      // 3. 执行 SQL (run 用于增加/修改/删除)
      stmt.run(
        input.requestId,
        input.sessionId,
        input.mode,
        status,
        input.modelId ?? null,      // JS的 undefined 对应 SQLite 的 null
        input.providerId ?? null,
        startedAt
      );

      // 4. 返回拼装好的实体
      return this.getTurnById(input.requestId) as Promise<TurnRecord>;
    },


    // ----------------------------------------
    // 按 ID 查询一条 Turn
    // ----------------------------------------
    async getTurnById(requestId: string): Promise<TurnRecord | null> {
      // 1. 准备 SQL 并且只取一条 (get)
      const row = db.prepare(`SELECT * FROM turns WHERE request_id = ?`).get(requestId);
      
      // 2. 如果没查到，返回 null
      if (!row) return null;
      
      // 3. 映射并返回
      return rowToTurn(row);
    },


    // ----------------------------------------
    // 更新 Turn 的状态与用量信息
    // ----------------------------------------
    async updateTurn(input: UpdateTurnInput): Promise<void> {
      // 为了支持局部更新 (Partial Update)，我们动态拼装 SQL 
      // 工业级小技巧：把要更新的列和值收集起来
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
        // 把对象 Stringify 回 JSON 字符串存入数据库
        values.push(JSON.stringify(input.usage)); 
      }

      if (updates.length === 0) return; // 没东西可更新就直接返回

      // 把 request_id 塞进参数数组最后面，供 WHERE 条件使用
      values.push(input.requestId);

      const sql = `UPDATE turns SET ${updates.join(", ")} WHERE request_id = ?`;
      db.prepare(sql).run(...values);
    },


    // ----------------------------------------
    // 分页查询 (基于游标 cursor)
    // ----------------------------------------
    async listTurnsBySession(sessionId: string, options?: ListTurnsOptions): Promise<TurnPage> {
      const limit = options?.limit ?? 20; // 默认查 20 条
      
      let sql = `SELECT * FROM turns WHERE session_id = ?`;
      const params: any[] = [sessionId];

      // 如果有游标 (beforeStartedAt)，附加时间过滤条件
      if (options?.beforeStartedAt) {
        sql += ` AND started_at < ?`;
        params.push(options.beforeStartedAt);
      }

      // 按照时间倒序，每次多查 1 条，用来判断 "hasMore"
      sql += ` ORDER BY started_at DESC LIMIT ?`;
      params.push(limit + 1);

      // 查询多条数据 (all)
      const rows = db.prepare(sql).all(...params) as any[];

      // 判断有没有下一页
      const hasMore = rows.length > limit;
      // 截断多查出来的那 1 条
      const items = hasMore ? rows.slice(0, limit) : rows;

      const records = items.map(rowToTurn);

      return {
        items: records,
        hasMore,
        // 上拉加载下一页的游标：就是当前这批数据里最老的那一条的时间
        nextBeforeStartedAt: hasMore ? records[records.length - 1].startedAt : undefined
      };
    }
  };
}