import { describe, expect, it } from 'vitest';
import type { CharacterCardId, LlmCallId, SessionId, TurnId } from '@ema-agent/contracts';
import { HookBus } from '@ema-agent/hook';
import { registerPromptsHooks } from '../src/hooks.js';

const sessionId = 'session-prompts' as SessionId;
const turnId = 'turn-prompts' as TurnId;
const llmCallId = 'llm-call-prompts' as LlmCallId;

describe('registerPromptsHooks', () => {
  it('只通过 messages 写入 system prompt，并替换旧 system message', async () => {
    const hooks = new HookBus();
    const card = {
      id: 'card-1' as CharacterCardId,
      name: 'Ema',
      version: '1.0.0',
      description: null,
      systemPrompt: 'You are Ema.',
      speechPatterns: [],
      forbiddenTopics: [],
      emotionVocabulary: ['happy'],
      motionVocabulary: ['wave'],
      isBuiltin: false,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const unregister = registerPromptsHooks(hooks, {
      card: { current: () => card } as never,
    });

    try {
      const result = await hooks.trigger('beforeLlm', {
        sessionId,
        turnId,
        payload: {
          iteration: 1,
          llmCallId,
          messages: [
            { role: 'system', content: 'stale system prompt' },
            { role: 'user', content: 'hello' },
          ],
          mode: 'chat',
          userInput: 'hello',
          providerId: 'provider-1',
          model: 'model-1',
        },
      });

      expect(result.kind).toBe('continue');
      expect(result.payload.messages).toHaveLength(2);
      expect(result.payload.messages[0]).toEqual(expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('You are Ema.'),
      }));
      expect(result.payload.messages[1]).toEqual({ role: 'user', content: 'hello' });
      expect('systemPrompt' in result.payload).toBe(false);
    } finally {
      unregister();
    }
  });
});
