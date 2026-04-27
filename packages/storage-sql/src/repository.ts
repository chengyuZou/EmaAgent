import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  CreateSessionInput,
  CreateTurnInput,
  EmaMode,
  ListMessagesOptions,
  ListTurnsOptions,
  MessageContentBlock,
  MessagePage,
  SessionRepository,
  SessionState,
  SessionSummary,
  SessionTitleStatus,
  ToolCall,
  TurnPage,
  TurnRecord,
  TurnRepository,
  TurnStatus,
  UpdateTurnInput,
  UsageView,
} from "@ema-agent/core-types";
import { migrateDatabase } from "./migrate.js";
import type { SqliteDatabaseLike } from "./migrate.js";

/** 默认数据库路径。桌面端后续会改成 Tauri app data 目录。 */
const DEFAULT_SQLITE_PATH = "data/ema-agent.sqlite";

/** 创建 SQLite 仓储时可配置的选项。 */
export interface SqliteSessionRepositoryOptions {
  /** 数据库文件路径；不传则使用 data/ema-agent.sqlite。 */
  databasePath?: string;
}

interface SessionRow {
  id: string;
  title: string;
  mode_last: EmaMode;
  title_status: SessionTitleStatus;
  title_updated_at: number | null;
  created_at: number;
  updated_at: number;
  full_access: number;
  active_skills_json: string;
}

interface MessageRow {
  id: string;
  request_id: string | null;
  role: ChatMessage["role"];
  content: string;
  content_blocks_json: string;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  created_at: number;
}

interface SessionSummaryRow {
  id: string;
  title: string;
  modeLast: EmaMode;
  updatedAt: number;
  messageCount: number;
}

interface TurnRow {
  request_id: string;
  session_id: string;
  mode: EmaMode;
  status: TurnStatus;
  model_id: string | null;
  provider_id: string | null;
  started_at: number;
  ended_at: number | null;
  usage_json: string | null;
  cost_usd: number | null;
}

/** storage-sql 提供给 session-runtime 的组合仓储。 */
export type SqliteRuntimeRepository = SessionRepository & TurnRepository;

/** 创建基于 SQLite 的 SessionRepository。 */
export function createSqliteSessionRepository(
  options: SqliteSessionRepositoryOptions = {},
): SqliteRuntimeRepository {
  const configuredPath = options.databasePath ?? DEFAULT_SQLITE_PATH;
  const databasePath = configuredPath === ":memory:" ? configuredPath : resolve(configuredPath);

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  migrateDatabase(db);
  return new SqliteSessionRepository(db);
}

/**
 * V1 SQLite 会话仓储。
 *
 * 目前实现 session-runtime 需要的最小接口，同时数据库已经具备 turns / steps /
 * artifacts 等 Day2 表结构，后续 runtime 可以逐步补专用 repository。
 */
export class SqliteSessionRepository implements SessionRepository, TurnRepository {
  constructor(private readonly db: SqliteDatabaseLike) {}

  async create(input: CreateSessionInput): Promise<SessionState> {
    const now = input.createdAt ?? Date.now();
    const session: SessionState = {
      id: input.id,
      title: input.title ?? "New Chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
      fullAccess: false,
      activeSkills: [],
      titleStatus: "default",
      modeLast: input.modeLast ?? "chat",
      mode: input.modeLast ?? "chat",
    };

    await this.save(session);
    return session;
  }

  async getById(sessionId: string): Promise<SessionState | null> {
    const sessionRow = this.db
      .prepare(
        `SELECT
          id,
          title,
          mode_last,
          title_status,
          title_updated_at,
          created_at,
          updated_at,
          full_access,
          active_skills_json
        FROM sessions
        WHERE id = :sessionId`,
      )
      .get<SessionRow>({ sessionId });

    if (!sessionRow) {
      return null;
    }

    const messageRows = this.db
      .prepare(
        `SELECT
          id,
          request_id,
          role,
          content,
          content_blocks_json,
          tool_call_id,
          tool_calls_json,
          created_at
        FROM messages
        WHERE session_id = :sessionId
        ORDER BY created_at ASC`,
      )
      .all<MessageRow>({ sessionId });

    return {
      id: sessionRow.id,
      title: sessionRow.title,
      messages: messageRows.map(mapMessageRow),
      createdAt: sessionRow.created_at,
      updatedAt: sessionRow.updated_at,
      fullAccess: sessionRow.full_access === 1,
      activeSkills: parseJsonArray<string>(sessionRow.active_skills_json),
      titleStatus: sessionRow.title_status,
      titleUpdatedAt: sessionRow.title_updated_at ?? undefined,
      modeLast: sessionRow.mode_last,
      mode: sessionRow.mode_last,
    };
  }

  async save(session: SessionState): Promise<void> {
    const modeLast = session.modeLast ?? session.mode ?? "chat";
    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `INSERT INTO sessions (
            id,
            title,
            mode_last,
            title_status,
            title_updated_at,
            created_at,
            updated_at,
            full_access,
            active_skills_json
          )
          VALUES (
            :id,
            :title,
            :modeLast,
            :titleStatus,
            :titleUpdatedAt,
            :createdAt,
            :updatedAt,
            :fullAccess,
            :activeSkillsJson
          )
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            mode_last = excluded.mode_last,
            title_status = excluded.title_status,
            title_updated_at = excluded.title_updated_at,
            updated_at = excluded.updated_at,
            full_access = excluded.full_access,
            active_skills_json = excluded.active_skills_json`,
        )
        .run({
          id: session.id,
          title: session.title,
          modeLast,
          titleStatus: session.titleStatus,
          titleUpdatedAt: session.titleUpdatedAt ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          fullAccess: session.fullAccess ? 1 : 0,
          activeSkillsJson: JSON.stringify(session.activeSkills),
        });

      this.db.prepare("DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE session_id = :sessionId)").run({
        sessionId: session.id,
      });
      // 当前接口仍然保存完整 session，因此先用 delete + batch insert 保持语义简单。
      this.db.prepare("DELETE FROM messages WHERE session_id = :sessionId").run({ sessionId: session.id });

      const insertMessage = this.db.prepare(
        `INSERT INTO messages (
          id,
          session_id,
          request_id,
          role,
          content,
          content_blocks_json,
          tool_call_id,
          tool_calls_json,
          created_at
        )
        VALUES (
          :id,
          :sessionId,
          :requestId,
          :role,
          :content,
          :contentBlocksJson,
          :toolCallId,
          :toolCallsJson,
          :createdAt
        )`,
      );
      const insertMessageFts = this.db.prepare(
        "INSERT INTO messages_fts (message_id, content) VALUES (:messageId, :content)",
      );

      for (const message of session.messages) {
        insertMessage.run({
          id: message.id,
          sessionId: session.id,
          requestId: message.requestId ?? null,
          role: message.role,
          content: message.content,
          contentBlocksJson: JSON.stringify(message.contentBlocks ?? [{ type: "text", text: message.content }]),
          toolCallId: message.toolCallId ?? null,
          toolCallsJson: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          createdAt: message.createdAt,
        });
        insertMessageFts.run({ messageId: message.id, content: message.content });
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const now = Date.now();
    this.db.exec("BEGIN");

    try {
      this.insertMessage(sessionId, message);
      this.db.prepare("UPDATE sessions SET updated_at = :updatedAt WHERE id = :sessionId").run({
        sessionId,
        updatedAt: now,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async listMessages(sessionId: string, options: ListMessagesOptions = {}): Promise<MessagePage> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const params: Record<string, unknown> = {
      sessionId,
      limit: limit + 1,
    };
    const filters = ["session_id = :sessionId"];

    if (options.beforeCreatedAt !== undefined) {
      filters.push("created_at < :beforeCreatedAt");
      params.beforeCreatedAt = options.beforeCreatedAt;
    }

    if (!options.includeSystem) {
      filters.push("role <> 'system'");
    }

    if (!options.includeTool) {
      filters.push("role <> 'tool'");
    }

    const rows = this.db
      .prepare(
        `SELECT
          id,
          request_id,
          role,
          content,
          content_blocks_json,
          tool_call_id,
          tool_calls_json,
          created_at
        FROM messages
        WHERE ${filters.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT :limit`,
      )
      .all<MessageRow>(params);
    const pageRows = rows.slice(0, limit).reverse();
    const first = pageRows[0];

    return {
      items: pageRows.map(mapMessageRow),
      hasMore: rows.length > limit,
      nextBeforeCreatedAt: first?.created_at,
    };
  }

  async updateTitle(sessionId: string, title: string, status: SessionTitleStatus = "manual"): Promise<void> {
    this.db
      .prepare(
        `UPDATE sessions
        SET title = :title,
            title_status = :status,
            title_updated_at = :titleUpdatedAt,
            updated_at = :updatedAt
        WHERE id = :sessionId`,
      )
      .run({
        sessionId,
        title,
        status,
        titleUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });
  }

  async updateModeLast(sessionId: string, mode: EmaMode): Promise<void> {
    this.db
      .prepare("UPDATE sessions SET mode_last = :mode, updated_at = :updatedAt WHERE id = :sessionId")
      .run({
        sessionId,
        mode,
        updatedAt: Date.now(),
      });
  }

  async list(): Promise<SessionSummary[]> {
    return this.db
      .prepare(
        `SELECT
          s.id AS id,
          s.title AS title,
          s.mode_last AS modeLast,
          s.updated_at AS updatedAt,
          COUNT(m.id) AS messageCount
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC`,
      )
      .all<SessionSummaryRow>()
      .map((row) => ({
        id: row.id,
        title: row.title,
        modeLast: row.modeLast,
        updatedAt: row.updatedAt,
        messageCount: row.messageCount,
      }));
  }

  async delete(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = :sessionId").run({ sessionId });
  }

  async createTurn(input: CreateTurnInput): Promise<TurnRecord> {
    const record: TurnRecord = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      mode: input.mode,
      status: input.status ?? "running",
      modelId: input.modelId,
      providerId: input.providerId,
      startedAt: input.startedAt ?? Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO turns (
          request_id,
          session_id,
          mode,
          status,
          model_id,
          provider_id,
          started_at,
          ended_at,
          usage_json,
          cost_usd
        )
        VALUES (
          :requestId,
          :sessionId,
          :mode,
          :status,
          :modelId,
          :providerId,
          :startedAt,
          :endedAt,
          :usageJson,
          :costUsd
        )`,
      )
      .run({
        requestId: record.requestId,
        sessionId: record.sessionId,
        mode: record.mode,
        status: record.status,
        modelId: record.modelId ?? null,
        providerId: record.providerId ?? null,
        startedAt: record.startedAt,
        endedAt: null,
        usageJson: null,
        costUsd: null,
      });

    await this.updateModeLast(record.sessionId, record.mode);
    return record;
  }

  async getTurnById(requestId: string): Promise<TurnRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
          request_id,
          session_id,
          mode,
          status,
          model_id,
          provider_id,
          started_at,
          ended_at,
          usage_json,
          cost_usd
        FROM turns
        WHERE request_id = :requestId`,
      )
      .get<TurnRow>({ requestId });

    return row ? mapTurnRow(row) : null;
  }

  async updateTurn(input: UpdateTurnInput): Promise<void> {
    const existing = await this.getTurnById(input.requestId);
    if (!existing) {
      throw new Error(`Turn not found: ${input.requestId}`);
    }

    const usage = input.usage ?? existing.usage;
    this.db
      .prepare(
        `UPDATE turns
        SET status = :status,
            model_id = :modelId,
            provider_id = :providerId,
            ended_at = :endedAt,
            usage_json = :usageJson,
            cost_usd = :costUsd
        WHERE request_id = :requestId`,
      )
      .run({
        requestId: input.requestId,
        status: input.status ?? existing.status,
        modelId: input.modelId ?? existing.modelId ?? null,
        providerId: input.providerId ?? existing.providerId ?? null,
        endedAt: input.endedAt ?? existing.endedAt ?? null,
        usageJson: usage ? JSON.stringify(usage) : null,
        costUsd: input.costUsd ?? input.usage?.costUsd ?? existing.usage?.costUsd ?? null,
      });
  }

  async listTurnsBySession(sessionId: string, options: ListTurnsOptions = {}): Promise<TurnPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const params: Record<string, unknown> = {
      sessionId,
      limit: limit + 1,
    };
    const filters = ["session_id = :sessionId"];

    if (options.beforeStartedAt !== undefined) {
      filters.push("started_at < :beforeStartedAt");
      params.beforeStartedAt = options.beforeStartedAt;
    }

    const rows = this.db
      .prepare(
        `SELECT
          request_id,
          session_id,
          mode,
          status,
          model_id,
          provider_id,
          started_at,
          ended_at,
          usage_json,
          cost_usd
        FROM turns
        WHERE ${filters.join(" AND ")}
        ORDER BY started_at DESC
        LIMIT :limit`,
      )
      .all<TurnRow>(params);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map(mapTurnRow),
      hasMore: rows.length > limit,
      nextBeforeStartedAt: last?.started_at,
    };
  }

  private insertMessage(sessionId: string, message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (
          id,
          session_id,
          request_id,
          role,
          content,
          content_blocks_json,
          tool_call_id,
          tool_calls_json,
          created_at
        )
        VALUES (
          :id,
          :sessionId,
          :requestId,
          :role,
          :content,
          :contentBlocksJson,
          :toolCallId,
          :toolCallsJson,
          :createdAt
        )`,
      )
      .run({
        id: message.id,
        sessionId,
        requestId: message.requestId ?? null,
        role: message.role,
        content: message.content,
        contentBlocksJson: JSON.stringify(message.contentBlocks ?? [{ type: "text", text: message.content }]),
        toolCallId: message.toolCallId ?? null,
        toolCallsJson: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        createdAt: message.createdAt,
      });

    this.db
      .prepare("INSERT INTO messages_fts (message_id, content) VALUES (:messageId, :content)")
      .run({ messageId: message.id, content: message.content });
  }
}

function mapMessageRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    contentBlocks: parseJsonArray<MessageContentBlock>(row.content_blocks_json),
    requestId: row.request_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolCalls: row.tool_calls_json ? parseJsonArray<ToolCall>(row.tool_calls_json) : undefined,
    createdAt: row.created_at,
  };
}

function parseJsonArray<T>(json: string): T[] {
  const value = JSON.parse(json) as unknown;
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseJsonObject<T extends object>(json: string | null): T | undefined {
  if (!json) {
    return undefined;
  }

  const value = JSON.parse(json) as unknown;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : undefined;
}

function mapTurnRow(row: TurnRow): TurnRecord {
  const usage = parseJsonObject<UsageView>(row.usage_json);
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    mode: row.mode,
    status: row.status,
    modelId: row.model_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    usage: usage
      ? {
          ...usage,
          costUsd: row.cost_usd ?? usage.costUsd,
        }
      : undefined,
  };
}
