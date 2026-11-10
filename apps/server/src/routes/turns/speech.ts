import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStore } from '@ema-agent/turn';
import { SpeechRequestError } from '@ema-agent/speech';
import type { SpeechComposition } from '../../composition/speech.js';
import { jsonBody } from '../validate.js';

const generateBody = z.object({
  characterName: z.string().min(1).max(100).optional(),
});

export interface TurnSpeechRouteDeps {
  readonly turns: Pick<TurnStore, 'getTurn'>;
  readonly session: Pick<SessionStore, 'loadMessagesForTurn'>;
  readonly speech: Pick<SpeechComposition,
    'audioStore' | 'speechGenerator' | 'createTurnSpeechInput' | 'listSpeechAvailability' | 'getCharacterSpeechAvailability'>;
}

export const turnSpeechRoute = (deps: TurnSpeechRouteDeps) => new Hono()
  .get('/:turnId/audio-records', context => {
    const turn = deps.turns.getTurn(context.req.param('turnId'));
    if (!turn) return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    return context.json(deps.speech.audioStore.listAudioSummaries(turn.id));
  })
  .get('/:turnId/speech-availability', context => {
    const turn = deps.turns.getTurn(context.req.param('turnId'));
    if (!turn) return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    return context.json(deps.speech.listSpeechAvailability(turn, readableText(deps.session, turn.id)));
  })
  .get('/:turnId/speech-availability/:characterName', context => {
    const turn = deps.turns.getTurn(context.req.param('turnId'));
    if (!turn) return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    try {
      return context.json(deps.speech.getCharacterSpeechAvailability(
        turn, readableText(deps.session, turn.id), context.req.param('characterName'),
      ));
    } catch (error) {
      if (!(error instanceof SpeechRequestError) || error.code !== 'speech/character_not_found') throw error;
      return context.json({ error: error.code, message: error.message }, 404);
    }
  })
  .post('/:turnId/speech', jsonBody(generateBody), async context => {
    const turn = deps.turns.getTurn(context.req.param('turnId'));
    if (!turn) return context.json({ error: 'turn_not_found', message: '该轮对话不存在' }, 404);
    if (turn.status !== 'completed') {
      return context.json({ error: 'turn_not_completed', message: '只能为已完成的回复生成完整语音' }, 409);
    }
    const text = readableText(deps.session, turn.id);
    if (!text.trim()) {
      return context.json({ error: 'speech/no_text', message: '该轮没有可朗读的回复正文' }, 422);
    }
    try {
      const input = deps.speech.createTurnSpeechInput(turn.sessionId, turn.id, context.req.valid('json').characterName);
      return context.json(await deps.speech.speechGenerator.generateTurnAudio(input, text));
    } catch (error) {
      if (!(error instanceof SpeechRequestError)) throw error;
      const status = error.code === 'speech/already_generating' ? 409 : 422;
      return context.json({ error: error.code, message: error.message }, status);
    }
  });

function readableText(session: TurnSpeechRouteDeps['session'], turnId: string): string {
  return session.loadMessagesForTurn(turnId)
    .filter(message => message.role === 'assistant' && message.kind === 'normal')
    .flatMap(message => {
      if (!Array.isArray(message.blocks)) return [];
      return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []);
    })
    .join('\n\n');
}
