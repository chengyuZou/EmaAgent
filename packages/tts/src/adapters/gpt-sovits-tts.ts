import type { TtsAdapter, TtsProviderConfig, TtsProbeResult, TtsRequest, TtsStreamEvent } from '../types.js';
import { errorEvent, classifyFetchError, classifyHttpStatus } from '../errors.js';

// ── GPT-SoVITS 本地服务器(api_v2.py)─────────────────────────────────────
//
// POST {baseUrl}/tts,JSON body:
//   {
//     text:                 "...",
//     text_lang:            "zh",          // 文本语言
//     ref_audio_path:       "/path/to/ref.wav",
//     prompt_text:          "...",
//     prompt_lang:          "zh",
//     media_type:           "wav" | "raw" | "ogg" | "aac",
//     streaming_mode:       true,           // chunked 响应
//     ...其他 GPT-SoVITS 旋钮
//   }
//
// 响应:chunked 音频体,content-type 匹配 media_type。
// 出错时,body 是 JSON:{ "message": "..." }。
//
// V1 只支持 clone:voice 带 refAudioPath、promptText、promptLang。
// `model` 字段仅作信息(GPT-SoVITS 不按请求切权重;用户重启服务器换权重)。

const CHUNK_BYTES = 8 * 1024;

export class GptSoVitsTtsAdapter implements TtsAdapter {
  readonly protocol = 'gpt-sovits-tts' as const;
  capabilitiesFor(): { audioDelivery: 'http_chunks'; supportsAbort: true } {
    return { audioDelivery: 'http_chunks', supportsAbort: true };
  }

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/tts`;
    const mediaType = mapFormatToGptSovits(req.format ?? 'mp3');

    const body = {
      text:           req.text,
      text_lang:      detectLangHint(req.text, req.voice.promptLang),
      ref_audio_path: req.voice.refAudioPath,
      prompt_text:    req.voice.promptText,
      prompt_lang:    req.voice.promptLang,
      media_type:     mediaType,
      streaming_mode: true,
      speed_factor:   req.speed ?? 1.0,
    };

    const startedAt = Date.now();
    let totalBytes  = 0;
    let firstByteMs = 0;

    let response: Response;
    try {
      response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  req.abortSignal,
      });
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      // GPT-SoVITS 在 refAudio 缺失时返 400 { "message": "ref_audio_path not exists" }
      // - 作为 permanent_refaudio_missing 上报。
      const code = looksLikeMissingRef(text)
        ? 'permanent_refaudio_missing'
        : classifyHttpStatus(response.status);
      yield errorEvent(code, `${response.status} ${text.slice(0, 200)}`);
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

  async probe(): Promise<TtsProbeResult> {
    const url = this.config.baseUrl.replace(/\/$/, '');
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const latencyMs = Date.now() - startedAt;
      // GPT-SoVITS 服务器 GET / 可能返 404,但仍说明它在线。
      return { ok: res.status < 500, latencyMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function looksLikeMissingRef(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('ref_audio_path') && (lower.includes('not exist') || lower.includes('not found'));
}

function mapFormatToGptSovits(format: string): string {
  // GPT-SoVITS api_v2 接受:wav、raw、ogg、aac
  switch (format) {
    case 'mp3':  return 'aac';   // 最接近的可用项
    case 'opus': return 'ogg';
    case 'pcm':  return 'raw';
    default:     return 'wav';
  }
}

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/aac';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

function detectLangHint(text: string, fallback: string): string {
  // 非常粗的启发式 - GPT-SoVITS 两边都接受 prompt_lang,但 text_lang
  // 影响合成发音。文本主要 CJK 用 'zh';主要 ASCII 字母用 'en';
  // 否则回退到 prompt 语言。
  const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > ascii) return 'zh';
  if (ascii > cjk * 2) return 'en';
  return fallback;
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
