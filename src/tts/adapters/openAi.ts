// 将语音合成请求转换为 OpenAI 兼容协议，并支持参考音频上传。

import type {
  TtsAdapter,
  TtsProviderConfig,
  TtsProviderVoiceHandle,
  TtsProbeResult,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { errorEvent, classifyFetchError, classifyHttpStatus, classifyProbeFailure } from '../errors.js';
import { mimeForFormat, mimeFromExt, concatBytes } from '../utils.js';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// ── OpenAI 兼容 /v1/audio/speech ─────────────────────────────────────────────
//
// 单次请求返回完整音频体。我们把响应体按合理块流式传出,让调用方能尽早
// 开始播放;这不是真正的句子级流式(OpenAI 不暴露),但响应比等完整体
// 更早开始到达。
//
// V1 只支持 clone：voice 必须带 Provider 句柄，由上层按需上传。
// clone 路径不发 speed/gain(CosyVoice2 克隆音色不接受这两个参数)。

const CHUNK_BYTES = 8 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;

export class OpenAiTtsAdapter implements TtsAdapter {
  readonly protocol = 'openai-tts' as const;
  capabilitiesFor(): { audioDelivery: 'http_chunks'; supportsAbort: true } {
    return { audioDelivery: 'http_chunks', supportsAbort: true };
  }

  constructor(private readonly config: Readonly<TtsProviderConfig>) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    if (!req.voice.providerVoice) {
      yield errorEvent('permanent_unsupported_voice_kind',
        'openai-tts adapter requires a provider voice handle');
      return;
    }

    const voiceParam = req.voice.providerVoice.value;

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/audio/speech`;
    const body: Record<string, unknown> = {
      model:           req.model,
      voice:           voiceParam,
      input:           req.text,
      response_format: req.format,
    };

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
      yield errorEvent(classifyFetchError(err, req.abortSignal), (err as Error).message);
      return;
    }

    if (!response.ok) {
      yield errorEvent(classifyHttpStatus(response.status), `TTS provider returned HTTP ${response.status}`);
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
        pending = concatBytes(pending, value);
        while (pending.length >= CHUNK_BYTES) {
          yield { type: 'audio_chunk', bytes: pending.slice(0, CHUNK_BYTES), mime };
          pending = pending.slice(CHUNK_BYTES);
        }
      }
      if (pending.length > 0) {
        yield { type: 'audio_chunk', bytes: pending, mime };
      }
    } catch (err) {
      yield errorEvent(classifyFetchError(err, req.abortSignal), (err as Error).message);
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
    signal?:      AbortSignal,
  ): Promise<TtsProviderVoiceHandle> {
    const fileStat = await stat(refAudioPath);
    if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
      throw new Error(`Reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`);
    }
    const bytes = await readFile(refAudioPath);
    const ext = basename(refAudioPath).split('.').pop()?.toLowerCase() ?? '';
    const blob  = new Blob([bytes], { type: mimeFromExt(ext) });
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`Voice upload failed: HTTP ${res.status}`);
    }

    const data = await res.json() as { uri?: string };
    if (!data.uri) {
      throw new Error('Voice upload response is missing uri');
    }
    // OpenAI 兼容供应商没有统一的有效期契约，默认按短期句柄处理。
    return {
      value: data.uri,
      lifetime: 'ephemeral',
    };
  }

  async probe(signal?: AbortSignal): Promise<TtsProbeResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok) return { ok: true, latencyMs };
      return { ok: false, latencyMs, error: `tts/${classifyHttpStatus(res.status)}` };
    } catch (err) {
      return { ok: false, error: classifyProbeFailure(err, signal) };
    }
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────
// mimeForFormat / mimeFromExt / concatBytes / safeReadText 已抽到 ../utils.ts 共用。
