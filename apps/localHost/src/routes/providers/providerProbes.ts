// 将 Provider 能力探测请求交给控制面，并保持每种能力的显式 URL。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ProviderConfigurationError,
  type Capability,
  type ProviderProbe,
} from '@ema-agent/provider';

const probeModelSchema = z.object({
  model: z.string().optional(),
}).strict();

const PROBE_CAPABILITIES: readonly Capability[] = [
  'llm',
  'vision',
  'embed',
  'rerank',
  'tts',
  'stt',
];

export function providerProbesRoute(probe: ProviderProbe): Hono {
  const app = new Hono();

  for (const capability of PROBE_CAPABILITIES) {
    app.post(`/:id/probe/${capability}`, async (c) => {
      const parsed = probeModelSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
      }
      try {
        return c.json(await probe.run(
          c.req.param('id'),
          capability,
          parsed.data.model,
          c.req.raw.signal,
        ));
      } catch (error) {
        if (!(error instanceof ProviderConfigurationError)) throw error;
        if (error.code === 'not_found') {
          return c.json({ error: 'not_found' }, 404);
        }
        if (error.code === 'capability_not_supported') {
          return c.json({
            error: 'capability_not_supported',
            capability,
          }, 422);
        }
        throw error;
      }
    });
  }

  return app;
}
