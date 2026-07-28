// 接收音频上传并把请求适配到无 Session 状态的 STT 执行面。
import { Hono } from 'hono';
import { isSttError, type SttRuntime } from '@ema-agent/stt';
import type { ModelBindingsRepo } from '@ema-agent/storage';

// ── POST /api/transcribe ────────────────────────────────────────────────────
//
// Multipart upload: `file` field (audio bytes), optional `language` field.
// Returns `{ text, segments? }` where segments may be absent if the provider
// doesn't support timestamps.
//
// Binding 在业务层解析，STT Runtime 不保存模型选择。

export function transcribeRoute(
  stt: Pick<SttRuntime, 'isAvailable' | 'maximumAudioBytes' | 'transcribe'>,
  modelBindings: Pick<ModelBindingsRepo, 'get'>,
): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    // Resolve STT binding from model_bindings — same pattern as the turns route.
    const binding = modelBindings.get('stt');
    if (!binding || !stt.isAvailable()) {
      return c.json({ error: 'stt_not_configured' }, 503);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }

    const file = form.get('file') as unknown;
    if (!(file instanceof File) && !(file instanceof Blob)) {
      return c.json({ error: 'missing_file_field' }, 400);
    }
    if (file.size > stt.maximumAudioBytes()) {
      return c.json({ error: 'payload_too_large' }, 413);
    }

    const language = typeof form.get('language') === 'string'
      ? (form.get('language') as string)
      : undefined;

    // 先用 Blob.size 拒绝超限输入，再分配 ArrayBuffer，避免大音频先占满内存后才校验。
    const buf  = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || 'audio/webm';

    try {
      const result = await stt.transcribe({
        providerId: binding.providerConfigId,
        model:      binding.model,
        audio:      buf,
        mime,
        language,
        abortSignal: c.req.raw.signal,
      });
      return c.json(result);
    } catch (err) {
      if (isSttError(err)) {
        const status = err.code === 'payload_too_large' ? 413
          : err.code === 'invalid_request' ? 400
          : err.code === 'aborted' ? 408
          : 502;
        return c.json({ error: err.code, message: err.message }, status);
      }
      return c.json({ error: 'stt_failed', message: 'STT request failed' }, 502);
    }
  });

  return app;
}
