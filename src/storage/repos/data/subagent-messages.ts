// 子代理与普通 Message 共用内容字段、时间/ID Cursor 和摘要边界, 只增加归属与 fork 来源.
import type { SqliteDb } from '../../database/database.js';
import type { MessageInsert, MessagePageCursor, MessageRow } from './messages.js';

export interface SubagentMessageRow extends Omit<MessageRow, 'session_id' | 'turn_id'> {
  subagent_id: string;
  /**
   * fork 时从当前 Session 复制到子代理的消息, 不是子代理某次 Run 产生的, 所以这里为 null.
   * 发给子代理的本次任务, 以及它执行时产生的消息, 才填写本次 Run 的 ID.
   */
  run_id: string | null;
  /**
   * 普通 Session 消息能通过 turnId 查到生成它的模型, 子代理自己生成的消息则通过 runId 查.
   * 但 fork 复制来的 Assistant 没有 runId, 而且可能来自多轮 Turn, 用过不同模型.
   * 所以这三列只为它们保存原来的供应商、模型和协议, 不能套用子代理本次 Run 的配置.
   * 子代理自己生成的消息不填写这三列, 查询时从所属 Run 取值; 备份只保存表里实际写入的值.
   */
  provider_id: string | null;
  model_id: string | null;
  protocol: string | null;
}

export interface SubagentMessageInsert extends Omit<MessageInsert, 'sessionId' | 'turnId'> {
  subagentId: string;
  /** fork 继承前缀为 null, 本次输入与输出归属具体 Run. */
  runId: string | null;
  /** 仅继承 Assistant 保存原来源; 自身输出通过 runId 取得来源. */
  providerId?: string;
  modelId?: string;
  protocol?: string;
}

export interface SubagentMessagePage {
  rows: SubagentMessageRow[];
  nextCursor: MessagePageCursor | null;
}

// 明确选择字段, 不让 m.* 的原始来源与 Run 派生来源出现重复列名.
const MESSAGE_SELECT = `
  SELECT m.id, m.subagent_id, m.run_id, m.role, m.kind, m.blocks_json,
    m.interrupted, m.created_at, m.summarized_through_message_id, m.summary_saved_tokens,
    CASE WHEN m.role = 'assistant' THEN
      CASE WHEN m.run_id IS NULL THEN m.provider_id ELSE r.provider_id END
    END AS provider_id,
    CASE WHEN m.role = 'assistant' THEN
      CASE WHEN m.run_id IS NULL THEN m.model_id ELSE r.model_id END
    END AS model_id,
    CASE WHEN m.role = 'assistant' THEN
      CASE WHEN m.run_id IS NULL THEN m.protocol ELSE r.protocol END
    END AS protocol
  FROM subagent_messages m LEFT JOIN subagent_runs r ON r.id = m.run_id`;

export class SubagentMessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 与主 Message 一样, 调用方按对话顺序生成单调 createdAt, Repo 不维护第二套编号. */
  insert(message: SubagentMessageInsert): void {
    this.db.prepare(
      `INSERT INTO subagent_messages (
         id, subagent_id, run_id, role, kind, blocks_json, interrupted, created_at,
         summarized_through_message_id, summary_saved_tokens, provider_id, model_id, protocol
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.subagentId,
      message.runId,
      message.role,
      message.kind ?? 'normal',
      message.blocksJson,
      message.interrupted ? 1 : 0,
      message.createdAt,
      message.summarizedThroughMessageId ?? null,
      message.savedTokens ?? null,
      message.providerId ?? null,
      message.modelId ?? null,
      message.protocol ?? null,
    );
  }

  /** 首次 fork 前缀与任务一起入库, 不留下半段初始化历史. */
  insertMany(messages: readonly SubagentMessageInsert[]): void {
    this.db.transaction(() => {
      for (const message of messages) this.insert(message);
    })();
  }

  updateBlocks(id: string, blocksJson: string): void {
    this.db.prepare(
      'UPDATE subagent_messages SET blocks_json = ? WHERE id = ?',
    ).run(blocksJson, id);
  }

  markInterrupted(id: string): void {
    this.db.prepare(
      'UPDATE subagent_messages SET interrupted = 1 WHERE id = ?',
    ).run(id);
  }

  listPage(subagentId: string, cursor: MessagePageCursor | undefined, limit = 50): SubagentMessagePage {
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const rows = this.db.prepare(
      `${MESSAGE_SELECT}
        WHERE m.subagent_id = ?
          AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    ).all(
      subagentId,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      pageSize + 1,
    ) as SubagentMessageRow[];
    const pageRows = rows.slice(0, pageSize);
    const last = pageRows.at(-1);
    let nextCursor: MessagePageCursor | null = null;
    if (rows.length > pageSize && last) {
      nextCursor = { createdAt: last.created_at, id: last.id };
    }
    return {
      rows: pageRows.reverse(),
      nextCursor,
    };
  }

  listAllForSubagent(subagentId: string): SubagentMessageRow[] {
    return this.db.prepare(
      `${MESSAGE_SELECT} WHERE m.subagent_id = ? ORDER BY m.created_at ASC, m.id ASC`,
    ).all(subagentId) as SubagentMessageRow[];
  }

  /**
   * 最新摘要放在有效历史开头, 覆盖边界使用目标消息的时间/ID.
   * 覆盖旧摘要时沿其游标找到原边界, 不吞掉旧摘要写入前但未覆盖的消息.
   */
  listForSubagentFromSummary(subagentId: string): SubagentMessageRow[] {
    return this.db.prepare(`
      WITH RECURSIVE latest_summary AS (
        SELECT * FROM subagent_messages WHERE subagent_id = ? AND kind = 'summary'
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), coverage_chain(id, depth) AS (
        SELECT COALESCE(summarized_through_message_id, id), 0 FROM latest_summary
        UNION ALL
        SELECT m.summarized_through_message_id, c.depth + 1
        FROM coverage_chain c JOIN subagent_messages m ON m.id = c.id
        WHERE m.subagent_id = ? AND m.kind = 'summary' AND m.summarized_through_message_id IS NOT NULL
      ), coverage_boundary AS (
        SELECT m.created_at, m.id FROM coverage_chain c JOIN subagent_messages m ON m.id = c.id
        WHERE m.subagent_id = ? ORDER BY c.depth DESC LIMIT 1
      )
      ${MESSAGE_SELECT}
      WHERE m.subagent_id = ? AND (
        m.id = (SELECT id FROM latest_summary)
        OR (m.kind <> 'summary' AND (
          NOT EXISTS (SELECT 1 FROM latest_summary)
          OR EXISTS (
            SELECT 1 FROM coverage_boundary b
            WHERE m.created_at > b.created_at OR (m.created_at = b.created_at AND m.id > b.id)
          )
        ))
      )
      ORDER BY CASE WHEN m.id = (SELECT id FROM latest_summary) THEN 0 ELSE 1 END,
        m.created_at ASC, m.id ASC
    `).all(subagentId, subagentId, subagentId, subagentId) as SubagentMessageRow[];
  }
}
