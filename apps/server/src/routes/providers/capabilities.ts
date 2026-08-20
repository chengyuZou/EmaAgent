// 能力执行端点：STT 转写（语音输入）与 TTS 试听（设置页）。绑定解析与记账归 composition/speech。
import { Hono } from 'hono';
import { z } from 'zod';
import { ProviderError } from '@ema-agent/providers';
import {
  SpeechVoicePreviewError,
  type SpeechVoicePreview,
} from '@ema-agent/speech';
import type { TranscriptionRequest, TranscriptionResult } from '@ema-agent/stt';
import { REQUEST_VALUE_LIMITS } from '../../platform/requestBudget.js';
import { providerError } from './configs.js';

const DEFAULT_PREVIEW_TEXT = '你好呀，很高兴见到你。';

const ttsPreviewBody = z.object({
  modelId: z.string().min(1),
  text: z.string().max(REQUEST_VALUE_LIMITS.maxTtsTestTextChars).optional(),
});

export interface ProviderCapabilitiesRouteDeps {
  readonly voicePreview: SpeechVoicePreview;
  /** STT 转写（装配层解析绑定并记账）；未绑定返回 undefined。 */
  readonly transcribe: (
    request: Omit<TranscriptionRequest, 'model'>,
  ) => Promise<TranscriptionResult | undefined>;
}

export function providerCapabilitiesRoute(deps: ProviderCapabilitiesRouteDeps): Hono {
  const app = new Hono();

  // 语音输入：multipart 的 file 字段是音频字节；STT 绑定缺失时如实 503。
  app.post('/transcribe', async context => {
    const form = await context.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return context.json({ error: 'invalid_audio' }, 400);
    }
    const language = form?.get('language');
    try {
      const result = await deps.transcribe({
        audio: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type || 'application/octet-stream',
        ...(typeof language === 'string' && language ? { language } : {}),
        signal: context.req.raw.signal,
      });
      if (!result) {
        return context.json({ error: 'stt_not_configured' }, 503);
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof ProviderError) return providerError(context, error);
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: 'transcribe_failed', message }, 502);
    }
  });

  // TTS 试听：用当前角色的参考音频对指定 Provider 模型发一句测试。
  app.post('/:providerId/tts-preview', async context => {
    const parsed = ttsPreviewBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const result = await deps.voicePreview.synthesize(
        context.req.param('providerId'),
        parsed.data.modelId,
        parsed.data.text?.trim() || DEFAULT_PREVIEW_TEXT,
        context.req.raw.signal,
      );
      return new Response(Uint8Array.from(result.bytes).buffer as ArrayBuffer, {
        headers: {
          'Content-Type': result.mime,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      if (!(error instanceof SpeechVoicePreviewError)) throw error;
      const status = error.code === 'synthesis_failed' ? 502 : 400;
      return context.json({ error: error.code, message: error.message }, status);
    }
  });

  return app;
}
