import type { Database } from "better-sqlite3";
import type { 
  SessionRepository, 
  SessionState, 
  CreateSessionInput,
  SessionTitleStatus,
  ListMessagesOptions,
  ChatMessage,
  EmaMode,
  SessionId
} from "@ema-agent/core-types";

// ==========================================
// 1. 数据映射器 (Row <-> Entity)
// ==========================================

function rowToSessionState(row: any): SessionState {
  return {
    id: row.id,
    title: row.title,
    lastMode: row.last_mode,
    fullAccess: Boolean(row.full_access),
    // 数据库里存 JSON 串，代码里复原成数组
    activeSkills: JSON.parse(row.active_skills || '[]'),
    titleStatus: row.title_status,
    titleUpdatedAt: row.title_updated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToMessage(row: any): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    requestId: row.request_id ?? undefined,
    status: row.status,
    errorCode: row.error_code ?? undefined,
    // 【核心】JSON反序列化，复原消息块
    contentBlocks: JSON.parse(row.content_blocks || '[]'),
    createdAt: row.created_at
  };
}

// ==========================================
// 2. 仓储工厂函数
// ==========================================

export function createSessionRepository(db: Database): SessionRepository {
  return {
    
    // ----------------------------------------
    // 【查】按 ID 获取会话
    // ----------------------------------------
    async getById(sessionId: SessionId) {
      const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      return row ? rowToSessionState(row) : null;
    },

    // ----------------------------------------
    // 【增】新建会话
    // ----------------------------------------
    async create(input: CreateSessionInput) {
      const now = input.createdAt ?? Date.now();
      const title = input.title ?? "New Chat";
      const lastMode = input.lastMode ?? "chat";

      db.prepare(`
        INSERT INTO sessions (id, title, last_mode, active_skills, created_at, updated_at) 
        VALUES (?, ?, ?, '[]', ?, ?)
      `).run(input.id, title, lastMode, now, now);

      return this.getById(input.id) as Promise<SessionState>;
    },

    // ----------------------------------------
    // 【改】全量保存/更新会话配置
    // ----------------------------------------
    async save(session: SessionState) {
      db.prepare(`
        UPDATE sessions SET 
          title = ?, 
          last_mode = ?, 
          full_access = ?, 
          active_skills = ?, 
          title_status = ?, 
          title_updated_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        session.title,
        session.lastMode,
        session.fullAccess ? 1 : 0,
        JSON.stringify(session.activeSkills),
        session.titleStatus,
        session.titleUpdatedAt ?? null,
        Date.now(),
        session.id
      );
    },

    // ----------------------------------------
    // 【删】删除会话及级联的消息！
    // ----------------------------------------
    async delete(sessionId: SessionId) {
      // 工业级提示：通常还要开启外键级联删除 PRAGMA foreign_keys = ON;
      // SQLite 跑这个动作是一个事务，不会有一半成功一半失败的问题。
      const deleteSession = db.transaction(() => {
        db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
      });
      deleteSession();
    },

    // ----------------------------------------
    // 【查列表】获取左侧边栏的摘要列表
    // ----------------------------------------
    async list() {
      // 这是一个稍微复杂的 SQL，它查询 Session 的同时，COUNT 数一数这个 Session 里面有几条消息
      const rows = db.prepare(`
        SELECT s.id, s.title, s.updated_at, s.last_mode, COUNT(m.id) as msg_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).all() as any[];

      return rows.map(row => ({
        id: row.id,
        title: row.title,
        lastMode: row.last_mode,
        updatedAt: row.updated_at,
        messageCount: Number(row.msg_count)
      }));
    },

    // ----------------------------------------
    // 【改局部】快速更新标题
    // ----------------------------------------
    async updateTitle(sessionId: SessionId, title: string, status?: SessionTitleStatus) {
      const dbStatus = status ?? "default";
      db.prepare(`
        UPDATE sessions SET title = ?, title_status = ?, title_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(title, dbStatus, Date.now(), Date.now(), sessionId);
    },

    // ----------------------------------------
    // 【改局部】更新最后模式
    // ----------------------------------------
    async updateLastMode(sessionId: SessionId, mode: EmaMode) {
      db.prepare(`
        UPDATE sessions SET last_mode = ?, updated_at = ? WHERE id = ?
      `).run(mode, Date.now(), sessionId);
    },

    // ----------------------------------------
    // 【消息写入】向会话追加（或更新）一条消息
    // ----------------------------------------
    async appendMessage(sessionId: SessionId, message: ChatMessage) {
      // 这里用 INSERT INTO ... ON CONFLICT (UPSERT)
      // 因为流式回复时，我们可能是一秒钟更新 5 次这条消息的内容！
      db.prepare(`
        INSERT INTO messages (
          id, session_id, role, content_blocks, request_id, status, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
          content_blocks = excluded.content_blocks,
          status = excluded.status,
          error_code = excluded.error_code
      `).run(
        message.id,
        sessionId,
        message.role,
        JSON.stringify(message.contentBlocks), // 把 Block 存成 JSON 文本
        message.requestId ?? null,
        message.status,
        message.errorCode ?? null,
        message.createdAt
      );

      // 有新消息了，顺便刷新一下 Session 的修改时间
      db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    },

    // ----------------------------------------
    // 【消息分页查询】游标读取长长长的聊天流
    // ----------------------------------------
    async listMessages(sessionId: SessionId, options?: ListMessagesOptions) {
      const limit = options?.limit ?? 50;
      
      // 注意：消息获取的顺序是 ASC (时间正序)，因为前端的下拉框是自上而下显示的！
      let sql = `SELECT * FROM messages WHERE session_id = ?`;
      const params: any[] = [sessionId];

      // 处理系统隐藏项
      if (options?.includeSystem !== true) {
        sql += ` AND role != 'system'`;
      }

      if (options?.beforeMessageId) {
        // 如果想拉取历史，我们要先找到游标的那条消息的创建时间
        const cursorMsg = db.prepare(`SELECT created_at FROM messages WHERE id = ?`).get(options.beforeMessageId) as any;
        if (cursorMsg) {
          sql += ` AND created_at < ?`;
          params.push(cursorMsg.created_at);
        }
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit + 1);

      // 上面查出来实际上是倒序的最新一批，所以要把它 reverse 反转一下，让时间正向流动交给前端
      const rows = db.prepare(sql).all(...params) as any[];
      const hasMore = rows.length > limit;
      let items = hasMore ? rows.slice(0, limit) : rows;
      
      // 返回给前端前必须确保是从老到新排列
      items = items.reverse();

      return {
        items: items.map(rowToMessage),
        hasMore,
        // 返回最老那条消息的 Id 作为下一次拉取历史的游标
        nextBeforeMessageId: hasMore && items.length > 0 ? items[0].id : undefined
      };
    }
  };
}