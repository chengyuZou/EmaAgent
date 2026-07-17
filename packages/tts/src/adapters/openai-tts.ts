// OpenAI 兼容协议的 adapter：POST /audio/speech 拿音频块，含参考音频上传做声音克隆。

import type { TtsAdapter, TtsProviderConfig, TtsProbeResult, TtsRequest, TtsStreamEvent } from '../types.js';
import { errorEvent, classifyFetchError, classifyHttpStatus } from '../errors.js';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// ── OpenAI 兼容 /v1/audio/speech ─────────────────────────────────────────────
//
// 单次请求返回完整音频体。我们把响应体按合理块流式传出,让调用方能尽早
// 开始播放;这不是真正的句子级流式(OpenAI 不暴露),但响应比等完整体
// 更早开始到达。
//
// V1 只支持 clone:voice 必须带 voiceUri(由 service 懒上传)。
// CosyVoice2 模型在 clone 路径上跳过 speed/gain 参数。

const CHUNK_BYTES = 8 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;

export class OpenAiTtsAdapter implements TtsAdapter {
  readonly protocol = 'openai-tts' as const;
  capabilitiesFor(): { audioDelivery: 'http_chunks'; supportsAbort: true } {
    return { audioDelivery: 'http_chunks', supportsAbort: true };
  }

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    if (!req.voice.voiceUri) {
      yield errorEvent('permanent_unsupported_voice_kind',
        'openai-tts adapter requires voiceUri (voice not yet uploaded)');
      return;
    }

    const voiceParam = req.voice.voiceUri;
    // Clone 路径总是跳过 speed/gain(CosyVoice2 不接受)。
    const skipSpeedGain = true;

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/audio/speech`;
    const body: Record<string, unknown> = {
      model:           req.model,
      voice:           voiceParam,
      input:           req.text,
      response_format: req.format,
    };
    if (!skipSpeedGain) {
      body.speed = req.speed ?? 1.0;
    }

    const startedAt = Date.now();
    let totalBytes  = 0;
    let firstByteMs = 0;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body:   JSON.stringify(body),
        signal: req.abortSignal,
      });
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      yield errorEvent(classifyHttpStatus(response.status), `${response.status} ${text.slice(0, 200)}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield errorEvent('unknown', 'response has no body');
      return;
    }

    const mime = response.headers.get('content-type') ?? mimeForFormat(req.format ?? 'mp3');

    try {
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
        totalBytes += value.length;

        // 重新分块到 ~8KB,让 SSE 帧保持合理大小
        pending = concat(pending, value);
        while (pending.length >= CHUNK_BYTES) {
          yield { type: 'audio_chunk', bytes: pending.slice(0, CHUNK_BYTES), mime };
          pending = pending.slice(CHUNK_BYTES);
        }
      }
      if (pending.length > 0) {
        yield { type: 'audio_chunk', bytes: pending, mime };
      }
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    yield { type: 'done', totalBytes, firstByteMs };
  }

  /**
   * 上传参考音频文件用于 voice cloning。
   *
   * SiliconFlow / OpenAI 兼容流程:
   *   POST /v1/uploads/audio/voice
   *   请求体 multipart/form-data，字段:file、model、customName、text
   *   响应:{ uri: "speech:xxx:xxx" }
   */
  async uploadVoice(
    refAudioPath: string,
    promptText:   string,
    promptLang:   string,
    model:        string,
  ): Promise<string> {
    const fileStat = await stat(refAudioPath);
    if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
      throw new Error(`Reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`);
    }
    const bytes = await readFile(refAudioPath);
    const blob  = new Blob([bytes], { type: mimeFromExt(refAudioPath) });
    const name  = basename(refAudioPath).replace(/\.[^.]+$/, '');
    const form  = new FormData();
    form.set('file', blob, basename(refAudioPath));
    form.set('model', model);
    form.set('customName', `ema-${name}`);
    form.set('text', promptText);
    form.set('language', promptLang || 'zh');

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/uploads/audio/voice`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Voice upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json() as { uri?: string };
    if (!data.uri) {
      throw new Error(`Voice upload response missing uri: ${JSON.stringify(data)}`);
    }
    return data.uri;
  }

  async probe(): Promise<TtsProbeResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok) return { ok: true, latencyMs };
      const text = await res.text().catch(() => '');
      return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/opus';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function mimeFromExt(filePath: string): string {
  const ext = basename(filePath).split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'ogg':
    case 'opus': return 'audio/ogg';
    case 'm4a':  return 'audio/mp4';
    default:     return 'audio/mpeg';
  }
}
