// 提供 Session 创建、查询、偏好更新、独立 Fork 与消息读取的 HTTP 边界。
import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type {
  MessageBlocks,
  SessionAttachmentsResult,
  SessionWire,
  SessionMessagesResult,
  SessionMessageWindowWire,
  SessionsListResult,
  SessionsGroupedResult,
  SessionsSearchResult,
  TurnIndexPageWire,
} from '@ema-agent/session';
import type { TurnAttachment } from '@ema-agent/turn';
import type { AppBindings } from '../wiring/index.js';

const TITLE_PROMPT = `Generate a very short title (3–6 words, no quotes) that captures the topic of the following message. Reply with only the title.\n\nMessage: `;
const TITLE_MAX_CHARS = 60;

// ── Schemas ─────────────────────────────────────────────────────────────────

const listSessionsSchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  /**
   * 上一页返回的不透明 V1 cursor。长度只做边界防御，结构由 Session Facade 校验。
   */
  cursor: z.string().min(1).max(256).optional(),
});

const listMessagesSchema = z.object({
  before: z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
});

const listTurnIndexSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const messageWindowSchema = z.object({
  anchorTurnId: z.string().min(1).max(200),
  beforeTurns: z.coerce.number().int().min(0).max(25).default(8),
  afterTurns: z.coerce.number().int().min(0).max(25).default(12),
}).refine(
  (value) => value.beforeTurns + value.afterTurns <= 40,
  { message: 'message_window_too_large' },
);

const searchSessionsSchema = z.object({
  q:     z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const patchSessionSchema = z.object({
  title:          z.string().min(1).max(200).optional(),
  pinned:         z.boolean().optional(),
  groupLabel:     z.string().max(100).nullable().optional(),
  workspaceRoot: z.string().max(500).nullable().optional(),
  executionProfile: z.enum(['chat', 'work']).optional(),
  narrativePolicy: z.enum(['auto', 'always', 'off']).optional(),
  /** 用户希望该 Session 下一轮使用的模型；null 表示恢复系统默认选择。 */
  preferredModel: z.object({
    providerConfigId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(500),
  }).strict().nullable().optional(),
});

const forkSchema = z.object({
  untilTurnId: z.string().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('session_not_found');
}

function errorStartsWith(err: unknown, prefix: string): boolean {
  return err instanceof Error && err.message.startsWith(prefix);
}

function extractText(blocks: MessageBlocks): string {
  if (typeof blocks === 'string') return blocks;
  const part = (blocks as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return part?.text ?? '';
}

function truncateTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= TITLE_MAX_CHARS ? t : t.slice(0, TITLE_MAX_CHARS - 1) + '…';
}

// ── Route factory ────────────────────────────────────────────────────────────

const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export function sessionsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── POST /api/sessions — explicit session creation ─────────────────────────
  // Used by the "New chat" button. Sessions are also created implicitly on the
  // first POST /api/turns when no sessionId is supplied.
  app.post('/', async (c) => {
    const body = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const session = bindings.session.createSession({
      title: body.data.title,
    });
    // `satisfies` pins the JSON shape to the shared wire contract — if the
    // domain type drifts from what the frontend expects, this line fails the build.
    return c.json(session satisfies SessionWire, 201);
  });

  // ── GET /api/sessions — flat list (back-compat) ────────────────────────────
  app.get('/', (c) => {
    const query = listSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    try {
      const sessions = bindings.session.listSessions(query.data);
      return c.json(sessions satisfies SessionsListResult);
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid sessions cursor') {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      throw error;
    }
  });

  // ── GET /api/sessions/grouped — sidebar-ready grouped listing ──────────────
  app.get('/grouped', (c) => {
    const result = bindings.session.listSessionsGrouped();
    return c.json(result satisfies SessionsGroupedResult);
  });

  // ── GET /api/sessions/search?q=... — title/message search ────────────────
  app.get('/search', (c) => {
    const query = searchSessionsSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    const result = bindings.session.searchSessions({
      query: query.data.q,
      limit: query.data.limit,
    });
    return c.json(result satisfies SessionsSearchResult);
  });

  // ── GET /api/sessions/:id/turn-index ───────────────────────────────────────
  app.get('/:id/turn-index', (c) => {
    const query = listTurnIndexSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    try {
      const result = bindings.session.listTurnIndex(sessionId, query.data);
      return c.json(result satisfies TurnIndexPageWire);
    } catch (error) {
      if (isNotFound(error)) return c.json({ error: 'session_not_found' }, 404);
      if (error instanceof Error && error.message === 'Invalid turn index cursor') {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      throw error;
    }
  });

  // ── GET /api/sessions/:id/messages/window ──────────────────────────────────
  app.get('/:id/messages/window', (c) => {
    const query = messageWindowSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    try {
      const window = bindings.session.listMessageWindow(sessionId, {
        anchorTurnId: asTurnId(query.data.anchorTurnId),
        beforeTurns: query.data.beforeTurns,
        afterTurns: query.data.afterTurns,
      });
      return c.json({
        ...window,
        messages: enrichStoredAttachments(bindings, window.messages),
      } satisfies SessionMessageWindowWire);
    } catch (error) {
      if (isNotFound(error)) return c.json({ error: 'session_not_found' }, 404);
      if (
        errorStartsWith(error, 'turn_not_found')
        || errorStartsWith(error, 'session_ownership_violation')
      ) {
        return c.json({ error: 'turn_not_found' }, 404);
      }
      throw error;
    }
  });

  // ── GET /api/sessions/:id/messages ─────────────────────────────────────────
  app.get('/:id/messages', (c) => {
    const query = listMessagesSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }

    const sessionId = asSessionId(c.req.param('id'));
    const messages = bindings.session.listMessages(sessionId, query.data);
    const turns = bindings.session.listTurns(sessionId);
    const enriched = enrichStoredAttachments(bindings, messages);

    return c.json({ messages: enriched, turns } satisfies SessionMessagesResult);
  });

  // ── PUT /api/sessions/:id — partial update (title / pinned / groupLabel) ───
  app.put('/:id', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = patchSessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }

    try {
      bindings.session.patchSession(sessionId, {
        title:          body.data.title,
        pinned:         body.data.pinned,
        groupLabel:     'groupLabel' in body.data ? body.data.groupLabel ?? null : undefined,
        workspaceRoot:  body.data.workspaceRoot,
        executionProfile: body.data.executionProfile,
        narrativePolicy: body.data.narrativePolicy,
        preferredModel: body.data.preferredModel,
      });
      if (body.data.workspaceRoot !== undefined) {
        // The cached CommandRunner baked the old root into its sandbox
        // config — drop it so the next turn rebuilds against the new one.
        bindings.invalidateSessionRuntime(sessionId);
      }
      return c.json(bindings.session.getSession(sessionId));
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── POST /api/sessions/:id/title — LLM-generated title (fire-and-forget) ───
  // Frontend calls this after the first turn of a new session completes.
  // Uses the 'title' binding; falls back to truncating the first user message.
  app.post('/:id/title', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));

    try {
      const messages = bindings.session.listMessages(sessionId, { limit: 10 });
      const firstUser = messages.find((m) => m.role === 'user');
      if (!firstUser) return c.body(null, 204);

      const firstText = extractText(firstUser.blocks);
      if (!firstText) return c.body(null, 204);

      // Build title: try LLM first, fall back to truncation.
      let title: string;

      const binding    = bindings.modelBindings.get('title');
      const providerId = binding?.providerConfigId;
      const model = binding?.model;

      if (providerId && model) {
        try {
          const result = await bindings.llm.complete({
            providerId,
            model,
            maxTokens: 32,
            temperature: 0,
            messages: [
              { role: 'user', content: [{ type: 'text', text: TITLE_PROMPT + firstText.slice(0, 400) }] },
            ],
          });
          const textBlock = result.blocks.find((b) => b.type === 'text');
          title = textBlock
            ? textBlock.text.trim().replace(/^["']|["']$/g, '').slice(0, TITLE_MAX_CHARS)
            : truncateTitle(firstText);
        } catch {
          title = truncateTitle(firstText);
        }
      } else {
        title = truncateTitle(firstText);
      }

      bindings.session.patchSession(sessionId, { title });
      return c.json({ title });
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── POST /api/sessions/:id/fork ────────────────────────────────────────────
  app.post('/:id/fork', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const body = forkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    try {
      const result = bindings.session.forkSession(
        sessionId,
        body.data.untilTurnId ? asTurnId(body.data.untilTurnId) : undefined,
      );
      return c.json(result, 201);
    } catch (err) {
      if (isNotFound(err)) return c.json({ error: 'session_not_found' }, 404);
      throw err;
    }
  });

  // ── POST /api/sessions/:id/turns/:turnId/rewind ────────────────────────────
  // 只服务“编辑最后一条用户消息”；不开放任意历史删除。
  app.post('/:id/turns/:turnId/rewind', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    const turnId = asTurnId(c.req.param('turnId'));
    try {
      return c.json(bindings.session.rewindLastTurn(sessionId, turnId));
    } catch (err) {
      if (errorStartsWith(err, 'turn_not_found')) return c.json({ error: 'turn_not_found' }, 404);
      if (errorStartsWith(err, 'turn_not_latest')) return c.json({ error: 'turn_not_latest' }, 409);
      if (errorStartsWith(err, 'turn_running')) return c.json({ error: 'turn_running' }, 409);
      if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
        return c.json({ error: 'turn_has_persistent_task' }, 409);
      }
      throw err;
    }
  });

  // ── POST /api/sessions/:id/viewed — mark session as seen by user ───────────
  // Updates last_viewed_at so hasUnread resets for this session.
  app.post('/:id/viewed', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    try {
      bindings.session.setViewedAt(sessionId);
    } catch { /* non-critical */ }
    return c.body(null, 204);
  });

  // ── POST /api/sessions/:id/archive ─────────────────────────────────────────
  app.post('/:id/archive', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.archiveSession(sessionId);
    return c.body(null, 204);
  });

  // ── POST /api/sessions/:id/unarchive ───────────────────────────────────────
  app.post('/:id/unarchive', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.session.unarchiveSession(sessionId);
    return c.body(null, 204);
  });

  // ── GET /api/sessions/:id/attachments ─────────────────────────────────────
  // Returns every turn_attachment for this session, ordered newest-first.
  app.get('/:id/attachments', async (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    try {
      // 先经 Session Facade 验证会话存在，再读取 Attachment 模块，避免不存在的
      // Session 被静默伪装成“附件为空”。
      bindings.session.getSession(sessionId);
      const inspected = await bindings.attachmentStore.inspectBySession(sessionId);
      const attachments = inspected.map((attachment) => ({
        id:         attachment.id,
        turnId:     attachment.turnId,
        sessionId:  attachment.sessionId,
        name:       attachment.name,
        mimeType:   attachment.mime,
        size:       attachment.size,
        mtime:      attachment.mtime,
        fileHandle: issueStoredFileHandle(bindings, attachment.localPath),
        createdAt:  attachment.createdAt,
        fileStatus: attachment.fileStatus,
      }));
      return c.json({ attachments } satisfies SessionAttachmentsResult);
    } catch (error) {
      if (isNotFound(error)) return c.json({ error: 'session_not_found' }, 404);
      throw error;
    }
  });

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────────
  app.delete('/:id', (c) => {
    const sessionId = asSessionId(c.req.param('id'));
    bindings.permissionPrompts.cancelForSession(sessionId, 'session deleted');
    bindings.permission.clearSession(sessionId);
    bindings.removeSessionRuntime(sessionId);
    bindings.session.deleteSession(sessionId);
    return c.body(null, 204);
  });

  return app;
}

function issueStoredFileHandle(bindings: AppBindings, localPath: string): string | null {
  try {
    return bindings.fileAccess.issue(localPath);
  } catch (error) {
    console.warn('[attachments] 无法为历史路径签发文件能力:', error);
    return null;
  }
}

function enrichStoredAttachments<T extends {
  role: string;
  turnId: string | null;
}>(bindings: AppBindings, messages: readonly T[]): Array<T & {
  attachments?: TurnAttachment[];
}> {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.turnId) return message;
    const rows = bindings.attachmentStore.listByTurn(message.turnId);
    if (rows.length === 0) return message;
    const attachments: TurnAttachment[] = rows.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mime,
      size: attachment.size,
      mtime: attachment.mtime,
      fileHandle: issueStoredFileHandle(bindings, attachment.localPath),
    }));
    return { ...message, attachments };
  });
}
