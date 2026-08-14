// 在 Composition Root 装配 Session 生命周期、标题模型适配器与 HTTP 子资源。
import type { Hono } from 'hono';
import { SessionLifecycle, SessionTitleGenerator } from '@ema-agent/session';
import { sessionsRoute } from '../routes/sessions/index.js';
import type { AppBindings } from './bindings.js';

export function createSessionsRouter(bindings: AppBindings): Hono {
  const lifecycle = new SessionLifecycle({
    session: bindings.session,
    runtime: {
      invalidateSessionRuntime: bindings.invalidateSessionRuntime,
      removeSessionRuntime: bindings.removeSessionRuntime,
    },
    interactions: bindings.interactionQueue,
    permissions: bindings.permission,
    memory: bindings.memory,
  });

  const titleGenerator = new SessionTitleGenerator(bindings.session, {
    async completeTitle(prompt) {
      const binding = bindings.modelBindings.get('title');
      if (!binding?.providerConfigId || !binding.model) return undefined;

      const result = await bindings.llm.complete({
        providerId: binding.providerConfigId,
        model: binding.model,
        maxTokens: 32,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        }],
      });
      const text = result.blocks.find((block) => block.type === 'text');
      return text?.text;
    },
  });

  return sessionsRoute(
    bindings.session,
    lifecycle,
    titleGenerator,
    bindings.attachmentStore,
    bindings.fileAccess,
  );
}
