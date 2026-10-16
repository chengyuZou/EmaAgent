// Session 历史读取：Message 正文分页、Message 锚点窗口、Turn 导航索引与终态收口。
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionMessage, SessionStore } from '@ema-agent/session';
import type { UsageRecorder } from '@ema-agent/usage';
import type { Turn, TurnStore } from '@ema-agent/turn';
import { TurnPreparationError } from '@ema-agent/turn';
import { ProviderError } from '@ema-agent/providers';
import type { TurnComposition } from '../../composition/turn.js';
import { queryValidator } from '../validate.js';

const listMessagesQuery = z.object({
  before: z.string().min(1).max(512).optional(),
  after: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  value => value.before === undefined || value.after === undefined,
  { message: 'message_cursor_direction_conflict' },
);

const turnIndexQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const messagesAroundQuery = z.object({
  anchorMessageId: z.string().min(1),
  before: z.coerce.number().int().min(0).max(100).default(20),
  after: z.coerce.number().int().min(0).max(100).default(30),
}).refine(
  value => value.before + value.after <= 100,
  { message: 'message_window_too_large' },
);

export interface SessionHistoryRouteDeps {
  readonly session: Pick<SessionStore, 'getSession' | 'loadHistory' | 'listMessages' | 'listMessagesAround' | 'loadMessagesForTurn'>;
  readonly turns: Pick<TurnStore, 'getTurn' | 'listTurnIndex'>;
  readonly usageRecorder: Pick<UsageRecorder, 'forTurn'>;
  readonly estimateContext: TurnComposition['estimateContext'];
  /** Session 被打开(拉历史)时触发一次 fire-and-forget 的附件残留清扫。 */
  readonly onSessionOpened?: (sessionId: string) => void;
}

function toTurnStats(
  turn: Turn,
  usageRecorder: Pick<UsageRecorder, 'forTurn'>,
) {
  const llmCalls = usageRecorder.forTurn(turn.id).filter(record => record.capability === 'llm');
  return {
    turnId: turn.id,
    status: turn.status,
    errorCode: turn.errorCode,
    errorMessage: turn.errorMessage,
    inputTokens: llmCalls.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
    outputTokens: llmCalls.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
    durationMs: turn.completedAt === null ? null : turn.completedAt - turn.createdAt,
  };
}

function turnStatsForMessages(
  messages: readonly SessionMessage[],
  turns: Pick<TurnStore, 'getTurn'>,
  usageRecorder: Pick<UsageRecorder, 'forTurn'>,
) {
  const turnIds = new Set(messages.flatMap(message => message.turnId ? [message.turnId] : []));
  return [...turnIds].flatMap(turnId => {
    const turn = turns.getTurn(turnId);
    return turn ? [toTurnStats(turn, usageRecorder)] : [];
  });
}

export const sessionHistoryRoute = (deps: SessionHistoryRouteDeps) =>
  new Hono()
    .get('/:sessionId/context-estimate', async context => {
      const sessionId = context.req.param('sessionId');
      try {
        return context.json(await deps.estimateContext(sessionId, context.req.raw.signal));
      } catch (error) {
        if (context.req.raw.signal.aborted) return context.json({ error: 'request_cancelled' }, 408);
        if (error instanceof Error && error.message.startsWith('session_not_found:')) {
          return context.json({ error: 'session_not_found' }, 404);
        }
        if (error instanceof TurnPreparationError && error.code === 'provider/not_configured') {
          return context.json({ error: error.code }, 409);
        }
        if (error instanceof ProviderError && error.code === 'model_not_found') {
          return context.json({ error: error.code }, 409);
        }
        throw error;
      }
    })
    .get('/:sessionId/messages/around', queryValidator(messagesAroundQuery), context => {
      try {
        const page = deps.session.listMessagesAround(
          context.req.param('sessionId'),
          context.req.valid('query'),
        );
        return context.json({
          ...page,
          turnStats: turnStatsForMessages(
            page.messages,
            deps.turns,
            deps.usageRecorder,
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('message_not_found') || message.includes('session_ownership_violation')) {
          return context.json({ error: 'message_not_found' }, 404);
        }
        throw error;
      }
    })
    .get('/:sessionId/messages', queryValidator(listMessagesQuery), context => {
      const sessionId = context.req.param('sessionId');
      deps.onSessionOpened?.(sessionId);
      const page = deps.session.listMessages(sessionId, context.req.valid('query'));
      return context.json({
        ...page,
        turnStats: turnStatsForMessages(
          page.messages,
          deps.turns,
          deps.usageRecorder,
        ),
      });
    })
    .get('/:sessionId/turn-index', queryValidator(turnIndexQuery), context => {
      return context.json(deps.turns.listTurnIndex(context.req.param('sessionId'), context.req.valid('query')));
    })
    .get('/:sessionId/turns/:turnId/messages', context => {
      const sessionId = context.req.param('sessionId');
      const turn = deps.turns.getTurn(context.req.param('turnId'));
      if (!turn || turn.sessionId !== sessionId) {
        return context.json({ error: 'turn_not_found' }, 404);
      }
      return context.json({
        messages: deps.session.loadMessagesForTurn(turn.id),
        turnStats: [toTurnStats(turn, deps.usageRecorder)],
      });
    });
