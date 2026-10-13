import { Hono } from 'hono';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { TurnSpeechRequestError, type SpeechComposition } from '../../composition/speech.js';

export interface TurnSpeechRouteDeps {
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly session: Pick<SessionStore, 'loadMessagesForTurn'>;
  readonly speech: Pick<SpeechComposition, 'generateTurnSpeech' | 'cancelTurnSpeech'>;
}

export const turnSpeechRoute = (deps: TurnSpeechRouteDeps) => new Hono()
  .post('/:turnId/speech', async context => {
    const turn = deps.turns.getTurn(context.req.param('turnId'));
    if (!turn) return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    if (turn.status !== 'completed') {
      return context.json({ error: 'turn_not_completed', message: '只能为已完成的回复生成完整语音' }, 409);
    }
    const text = deps.session.loadMessagesForTurn(turn.id)
      .filter(message => message.role === 'assistant' && message.kind === 'normal')
      .flatMap(message => {
        if (!Array.isArray(message.blocks)) return [];
        return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []);
      })
      .join('\n\n');
    if (!text.trim()) {
      return context.json({ error: 'speech/no_text', message: '该轮没有可朗读的回复正文' }, 422);
    }
    try {
      return context.json(await deps.speech.generateTurnSpeech(turn, text));
    } catch (error) {
      if (!(error instanceof TurnSpeechRequestError)) throw error;
      const status = error.code === 'speech/already_generating' ? 409 : 422;
      return context.json({ error: error.code, message: error.message }, status);
    }
  })
  .post('/:turnId/speech/cancel', async context => {
    if (!deps.turns.getTurn(context.req.param('turnId'))) {
      return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    }
    await deps.speech.cancelTurnSpeech(context.req.param('turnId'));
    return context.body(null, 204);
  });
