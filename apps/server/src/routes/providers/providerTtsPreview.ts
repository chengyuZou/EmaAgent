// 解析 Provider 声音试听请求，并把 TTS 业务结果编码为不可缓存的音频响应。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  TtsVoicePreviewError,
  type TtsVoicePreview,
} from '@ema-agent/tts';
import { REQUEST_VALUE_LIMITS } from '../../http/request-budget.js';

const ttsPreviewSchema = z.object({
  text: z.string().max(REQUEST_VALUE_LIMITS.maxTtsTestTextChars).optional(),
  model: z.string().min(1),
}).strict();

const DEFAULT_PREVIEW_TEXT = '你好，我是艾玛，很高兴认识你。';

export function providerTtsPreviewRoute(preview: TtsVoicePreview): Hono {
  const app = new Hono();

  app.post('/:id/tts-test', async (c) => {
    const parsed = ttsPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const model = parsed.data.model.trim();
    if (!model) return c.json({ error: 'model_required' }, 400);
    try {
      const result = await preview.synthesize(
        c.req.param('id'),
        model,
        parsed.data.text?.trim() || DEFAULT_PREVIEW_TEXT,
        c.req.raw.signal,
      );
      return new Response(Uint8Array.from(result.bytes).buffer, {
        headers: {
          'Content-Type': result.mime,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      if (!(error instanceof TtsVoicePreviewError)) throw error;
      switch (error.code) {
        case 'adapter_unavailable':
          return c.json({ error: 'tts_adapter_unavailable' }, 400);
        case 'no_reference_audio':
          return c.json({
            error: 'no_reference_audio',
            message: error.message,
          }, 400);
        case 'voice_upload_failed':
          return c.json({
            error: 'voice_upload_failed',
            message: error.message,
          }, 400);
        case 'no_audio':
          return c.json({ error: 'no_audio', message: error.message }, 502);
        case 'synthesis_failed':
          return c.json({
            error: 'tts_test_failed',
            message: error.message,
          }, 502);
      }
    }
  });

  return app;
}
