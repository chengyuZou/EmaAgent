// Session 历史读取：Message 正文分页、Message 锚点窗口、Turn 导航索引与终态收口。
import { Hono } from 'hono';
import { z } from 'zod';
import type { Message, SessionStore } from '@ema-agent/session';
import type { UsageRecordsRepo } from '@ema-agent/storage';
import type { Turn, TurnStore } from '@ema-agent/turn';
import type { AudioArchive } from '@ema-agent/speech';
import { buildHistoryMessages } from '@ema-agent/context';
import { estimateLlmInputTokens } from '@ema-agent/token';
import type { ProviderModels } from '@ema-agent/providers';
import { createGenerationTargetResolver } from '@ema-agent/turn';
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
  readonly usageRecords: Pick<UsageRecordsRepo, 'forTurn'>;
  readonly audioArchive: Pick<AudioArchive, 'findMergedFor'>;
  readonly providerModels: Pick<ProviderModels, 'get'>;
  /** Session 被打开(拉历史)时触发一次 fire-and-forget 的附件残留清扫。 */
  readonly onSessionOpened?: (sessionId: string) => void;
}

function toTurnStats(
  turn: Turn,
  usageRecords: Pick<UsageRecordsRepo, 'forTurn'>,
  audioArchive: Pick<AudioArchive, 'findMergedFor'>,
) {
  const llmCalls = usageRecords.forTurn(turn.id).filter(record => record.capability === 'llm');
  return {
    turnId: turn.id,
    inputTokens: llmCalls.reduce((sum, record) => sum + (record.input_tokens ?? 0), 0),
    outputTokens: llmCalls.reduce((sum, record) => sum + (record.output_tokens ?? 0), 0),
    durationMs: turn.completedAt === null ? null : turn.completedAt - turn.createdAt,
    audioAvailable: audioArchive.findMergedFor(turn.sessionId, turn.id) !== null,
  };
}

function turnStatsForMessages(
  messages: readonly Message[],
  turns: Pick<TurnStore, 'getTurn'>,
  usageRecords: Pick<UsageRecordsRepo, 'forTurn'>,
  audioArchive: Pick<AudioArchive, 'findMergedFor'>,
) {
  const turnIds = new Set(messages.flatMap(message => message.turnId ? [message.turnId] : []));
  return [...turnIds].flatMap(turnId => {
    const turn = turns.getTurn(turnId);
    return turn ? [toTurnStats(turn, usageRecords, audioArchive)] : [];
  });
}

export const sessionHistoryRoute = (deps: SessionHistoryRouteDeps) =>
  new Hono()
    .get('/:sessionId/context-estimate', async context => {
      const sessionId = context.req.param('sessionId');
      const session = deps.session.getSession(sessionId);
      const model = session.providerId && session.modelId
        ? deps.providerModels.get(session.providerId, 'llm', session.modelId)
        : undefined;
      // 与下一轮 Turn 共用摘要边界和 Message 投影. 此处只估算已保存历史,
      // 不执行尚未开始的 Prompt/Tool 装配, 也不为图片触发额外 Vision 调用.
      const history = await buildHistoryMessages(
        deps.session.loadHistory(sessionId),
        createGenerationTargetResolver(deps.turns),
        { supportsImageInput: model?.capability === 'llm' && model.inputImage === true,
          signal: context.req.raw.signal },
      );
      return context.json({
        inputTokens: estimateLlmInputTokens(history.map(entry => entry.message)).totalTokens,
        contextWindow: model?.capability === 'llm' ? model.contextWindow : 0,
      });
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
            deps.usageRecords,
            deps.audioArchive,
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
          deps.usageRecords,
          deps.audioArchive,
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
        turnStats: [toTurnStats(turn, deps.usageRecords, deps.audioArchive)],
      });
    });
