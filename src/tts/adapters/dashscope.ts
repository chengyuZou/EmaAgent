// 按模型选择 DashScope CosyVoice 或 Qwen-TTS 协议并返回音频帧。

import { randomUUID } from 'node:crypto';
import fs   from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

import type {
  TtsAdapter,
  TtsErrorCode,
  TtsProviderConfig,
  TtsProviderVoiceHandle,
  TtsProbeResult,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { classifyCloseCode, classifyFetchError, classifyHttpStatus, classifyProbeFailure } from '../errors.js';
import { mimeForFormat } from '../utils.js';

// ── DashScope(阿里云百炼)TTS ──────────────────────────────────────────────
//
// 一个 adapter,两个 WS 协议,按模型前缀路由:
//
//   - cosyvoice-*        -> wss://{host}/api-ws/v1/inference/
//                          actions:run-task -> continue-task -> finish-task
//                          音频:二进制帧
//                          控制:文本 JSON 帧
//
//   - qwen*-tts*         -> wss://{host}/api-ws/v1/realtime?model={model}
//                          流程:session.update -> input_text_buffer.append
//                               -> input_text_buffer.commit -> response.done
//                               -> session.finish -> session.finished
//                          音频:base64 在 `response.audio.delta.delta`
//
// 两个协议都通过单个 WS 连接交付 per-call 音频。V1 不做连接池/复用 -
// 一次 synthesize() = 一个 WS。连接池是阿里官方推荐的高并发最佳实践
// (对象池,1.5-2x 峰值 QPS),但桌宠单用户,峰值 ~1 QPS。

const HOST_DEFAULT = 'wss://dashscope.aliyuncs.com';
const MAX_REFERENCE_AUDIO_BYTES = 25 * 1024 * 1024;

export class DashscopeTtsAdapter implements TtsAdapter {
  readonly protocol = 'dashscope-tts' as const;

  capabilitiesFor(req: Pick<TtsRequest, 'model'>): {
    audioDelivery: 'buffered' | 'websocket_frames';
    supportsAbort: boolean;
  } {
    return {
      audioDelivery: dashscopeModelFamily(req.model) === 'qwen-tts'
        ? 'buffered'
        : 'websocket_frames',
      supportsAbort: true,
    };
  }

  constructor(private readonly config: Readonly<TtsProviderConfig>) {}

  stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const family = dashscopeModelFamily(req.model);
    if (family === 'cosyvoice') {
      return new CosyVoiceSession(this.config, req).run();
    }
    if (family === 'qwen-tts') {
      return new QwenTtsRealtimeSession(this.config, req).run();
    }
    return errorOnce('permanent_unsupported_model',
      `dashscope-tts: unknown model "${req.model}" (expected cosyvoice-* or qwen*-tts*)`);
  }

  /**
   * 上传本地参考音频文件到 DashScope 做 voice cloning。
   * 返回 Provider 分配的 voice ID。当前协议没有在响应中提供有效期，
   * 因此上层保守地只在当前进程内短期复用。
   *
   * 协议路由:
   *   cosyvoice-*  -> model=voice-enrollment,      input.url
   *   qwen*-tts*   -> model=qwen-voice-enrollment,  input.audio.data
   *
   * 音频传输:文件 base64 编码后作为 data URI 发送。
   * DashScope 文档用 https:// URL,但 data URI 实际可用。
   * 若未来 DashScope 拒绝 data URI,改两步:先经兼容模式 Files API
   * (POST /compatible-mode/v1/files)上传文件拿托管 URL,再用该 URL。
   */
  async uploadVoice(
    refAudioPath: string,
    _promptText:  string,
    _promptLang:  string,
    model:        string,
    signal?:      AbortSignal,
  ): Promise<TtsProviderVoiceHandle> {
    const family = dashscopeModelFamily(model);
    if (family === 'unknown') {
      throw new Error(`dashscope-tts: uploadVoice not supported for model "${model}"`);
    }

    const fileStat = await fs.stat(refAudioPath);
    if (fileStat.size > MAX_REFERENCE_AUDIO_BYTES) {
      throw new Error(`Reference audio exceeds ${MAX_REFERENCE_AUDIO_BYTES} bytes`);
    }
    // Data URI 必然需要一次有界缓冲;先检查文件大小,避免无上限读取和 base64 扩张。
    const audioBytes = await fs.readFile(refAudioPath);
    const ext  = path.extname(refAudioPath).slice(1).toLowerCase() || 'wav';
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`;
    const dataUri = `data:${mime};base64,${audioBytes.toString('base64')}`;

    const httpBase   = httpHostFromConfig(this.config.baseUrl).replace(/\/$/, '');
    const enrollUrl  = `${httpBase}/api/v1/services/audio/tts/customization`;

    const body: Record<string, unknown> = family === 'cosyvoice'
      ? {
          model: 'voice-enrollment',
          input: { action: 'create_voice', target_model: model, prefix: 'ema', url: dataUri },
        }
      : {
          model: 'qwen-voice-enrollment',
          input: {
            action: 'create', target_model: model, preferred_name: 'ema',
            audio: { data: dataUri },
          },
        };

    const resp = await fetch(enrollUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      throw new Error(`DashScope voice enrollment failed: HTTP ${resp.status}`);
    }

    // CosyVoice 响应:{ output: { voice_id: "prefix-xxxx" } }
    // Qwen-TTS 响应: { output: { voice: "name-xxxx" } }
    const json   = await resp.json() as Record<string, unknown>;
    const output = json['output'] as Record<string, unknown> | undefined;
    const voiceId = (output?.['voice_id'] ?? output?.['voice']) as string | undefined;

    if (!voiceId) {
      throw new Error('DashScope voice enrollment response is missing voice id');
    }

    return {
      value: voiceId,
      lifetime: 'ephemeral',
    };
  }

  async probe(signal?: AbortSignal): Promise<TtsProbeResult> {
    // DashScope 用 WebSocket;改用其 REST models API 探测。
    const url = 'https://dashscope.aliyuncs.com/api/v1/models';
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok || res.status === 404) return { ok: true, latencyMs };
      return { ok: false, latencyMs, error: `tts/${classifyHttpStatus(res.status)}` };
    } catch (err) {
      return { ok: false, error: classifyProbeFailure(err, signal) };
    }
  }
}

// ── 模型族检测 ──────────────────────────────────────────────────────────────

export function dashscopeModelFamily(model: string): 'cosyvoice' | 'qwen-tts' | 'unknown' {
  if (model.startsWith('cosyvoice')) return 'cosyvoice';
  if (model.startsWith('qwen') && model.includes('tts')) return 'qwen-tts';
  return 'unknown';
}

// ── 共享辅助函数 ──────────────────────────────────────────────────────────────

function wsHostFromConfig(baseUrl: string): string {
  // provider config 的 baseUrl 是 HTTPS 形式(https://dashscope.aliyuncs.com)。
  // 两个协议都转成 WSS。
  if (baseUrl.startsWith('wss://') || baseUrl.startsWith('ws://')) return baseUrl;
  if (baseUrl.startsWith('https://')) return 'wss://' + baseUrl.slice('https://'.length);
  if (baseUrl.startsWith('http://')) return 'ws://' + baseUrl.slice('http://'.length);
  return HOST_DEFAULT;
}

function httpHostFromConfig(baseUrl: string): string {
  // wsHostFromConfig 的逆操作 - REST enrollment API 调用需要。
  if (baseUrl.startsWith('https://') || baseUrl.startsWith('http://')) return baseUrl;
  if (baseUrl.startsWith('wss://')) return 'https://' + baseUrl.slice('wss://'.length);
  if (baseUrl.startsWith('ws://')) return 'http://' + baseUrl.slice('ws://'.length);
  return 'https://dashscope.aliyuncs.com';
}

async function* errorOnce(code: TtsErrorCode, message: string): AsyncGenerator<TtsStreamEvent> {
  yield { type: 'error', code, message };
}

// ── PCM -> WAV 转换 ────────────────────────────────────────────────────────────
//
// 把裸 16-bit 有符号 LE 单声道 PCM 包进标准 RIFF/WAV 容器,让浏览器无需
// 额外编解码协商即可播放。仅用于 Qwen-TTS(其 WS 协议总是交付 audio/L16)。

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels  = 1;
  const bitsPerSample = 16;
  const byteRate     = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign   = numChannels * (bitsPerSample / 8);
  const dataSize     = pcm.length;
  const header       = Buffer.alloc(44);

  header.write('RIFF',  0);                                   // ChunkID
  header.writeUInt32LE(36 + dataSize, 4);                     // ChunkSize
  header.write('WAVE',  8);                                   // Format
  header.write('fmt ',  12);                                  // Subchunk1ID
  header.writeUInt32LE(16,            16);                    // Subchunk1Size (PCM)
  header.writeUInt16LE(1,             20);                    // AudioFormat (PCM = 1)
  header.writeUInt16LE(numChannels,   22);                    // NumChannels
  header.writeUInt32LE(sampleRate,    24);                    // SampleRate
  header.writeUInt32LE(byteRate,      28);                    // ByteRate
  header.writeUInt16LE(blockAlign,    32);                    // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);                    // BitsPerSample
  header.write('data',  36);                                  // Subchunk2ID
  header.writeUInt32LE(dataSize,      40);                    // Subchunk2Size

  return Buffer.concat([header, pcm]);
}

// ── 事件驱动队列:桥接 ws 回调 -> AsyncIterable ──────────────────────────────
//
// 两个 session 类都用。模式:WS 处理器 push() 事件进队列,消费者 await
// dequeue()。关闭时 finalize() 用哨兵值解锁所有 pending dequeue。

class EventQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private closeValue: T | null = null;

  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) { r({ value: item, done: false }); return; }
    this.items.push(item);
  }

  /** 推入最终值并标记流关闭。 */
  closeWith(item: T): void {
    if (this.closed) return;
    this.closeValue = item;
    this.push(item);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers.splice(0)) r({ value: undefined as unknown as T, done: true });
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        const item = this.items.shift()!;
        yield item;
        if (this.closed && this.items.length === 0) return;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }

  // 静默 "unused" - 留作未来调试 / abort 流程检查。
  hasFinal(): boolean { return this.closeValue !== null; }
}

// ── CosyVoice session ───────────────────────────────────────────────────────
//
// 线协议(阿里文档):
//   1. 开 WS 到 /api-ws/v1/inference/,带 `Authorization: bearer <key>`
//   2. 发 run-task -> 等 task-started 事件
//   3. 发 continue-task 带 text -> 服务器发二进制音频帧
//   4. 发 finish-task -> 等 task-finished -> 关闭
//
// V1 只支持 clone：providerVoice 带声音复刻得到的 Provider 句柄。

class CosyVoiceSession {
  private readonly mime: string;

  constructor(
    private readonly config: Readonly<TtsProviderConfig>,
    private readonly req:    TtsRequest,
  ) {
    this.mime = mimeForFormat(req.format ?? 'mp3');
  }

  async *run(): AsyncGenerator<TtsStreamEvent> {
    const providerVoice = this.req.voice.providerVoice;
    if (!providerVoice) {
      yield { type: 'error', code: 'permanent_unsupported_voice_kind',
              message: 'cosyvoice (dashscope) requires a provider voice handle' };
      return;
    }

    const url = wsHostFromConfig(this.config.baseUrl).replace(/\/$/, '') + '/api-ws/v1/inference/';
    const taskId = randomUUID().replace(/-/g, '');
    const queue = new EventQueue<TtsStreamEvent>();
    const startedAt = Date.now();
    let firstByteMs = 0;
    let totalBytes  = 0;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          Authorization:                `bearer ${this.config.apiKey}`,
          'X-DashScope-DataInspection': 'enable',
        },
      });
    } catch (err) {
      yield { type: 'error', code: 'transient_network', message: (err as Error).message };
      return;
    }

    ws.binaryType = 'nodebuffer';

    let aborted = false;
    const abortHandler = (): void => {
      aborted = true;
      try { ws.close(1000, 'aborted'); } catch { /* ignore */ }
      queue.close();
    };
    this.req.abortSignal?.addEventListener('abort', abortHandler);

    const voice = this.req.voice;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task:       'tts',
          function:   'SpeechSynthesizer',
          model:      this.req.model,
          parameters: {
            text_type:   'PlainText',
            voice:       providerVoice.value,
            format:      this.req.format,
            sample_rate: this.req.sampleRate ?? defaultSampleRate(this.req.format ?? 'mp3'),
            volume:      50,
            rate:        this.req.speed ?? 1.0,
            pitch:       1.0,
            enable_ssml: false,
          },
          input: {},
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (aborted) return;

      if (isBinary) {
        // 音频帧
        const buf = data as Buffer;
        if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
        totalBytes += buf.length;
        queue.push({ type: 'audio_chunk', bytes: new Uint8Array(buf), mime: this.mime });
        return;
      }

      // 文本帧 - JSON 事件
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch { return; }

      const event = msg.header?.event;
      switch (event) {
        case 'task-started': {
          // 发 continue-task 带完整文本(V1 单段 - coordinator 已切句)
          ws.send(JSON.stringify({
            header:  { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: { text: this.req.text } },
          }));
          ws.send(JSON.stringify({
            header:  { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }));
          break;
        }
        case 'task-finished': {
          queue.push({ type: 'done', totalBytes, firstByteMs });
          queue.close();
          try { ws.close(1000, 'bye'); } catch { /* ignore */ }
          break;
        }
        case 'task-failed': {
          queue.closeWith({
            type: 'error',
            code: msg.header?.error_message?.toLowerCase().includes('auth')
                  ? 'permanent_credentials' : 'transient_server',
            message: msg.header?.error_message ?? 'cosyvoice task-failed',
          });
          try { ws.close(1000, 'failed'); } catch { /* ignore */ }
          break;
        }
        default:
          // result-generated 等中间事件 - 忽略
          break;
      }
    });

    ws.on('error', (err) => {
      if (aborted) return;
      queue.closeWith({ type: 'error', code: 'transient_network', message: err.message });
    });

    ws.on('close', (code) => {
      if (!queue.hasFinal() && !aborted) {
        queue.closeWith({
          type: 'error',
          code: classifyCloseCode(code),
          message: `cosyvoice ws closed (${code})`,
        });
      }
    });

    try {
      yield* queue.iterate();
    } finally {
      this.req.abortSignal?.removeEventListener('abort', abortHandler);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}

// ── Qwen-TTS Realtime session ───────────────────────────────────────────────
//
// 线协议(阿里文档):
//   1. 开 WS 到 /api-ws/v1/realtime?model=<model>,带 `Authorization: Bearer <key>`
//   2. 发 session.update 带 voice + response_format + mode='commit'
//   3. 发 input_text_buffer.append,再 input_text_buffer.commit
//   4. 服务器发 response.audio.delta(base64)+ response.done
//   5. 发 session.finish -> 等 session.finished -> 关闭

class QwenTtsRealtimeSession {
  private readonly pcmSr: number;

  constructor(
    private readonly config: Readonly<TtsProviderConfig>,
    private readonly req:    TtsRequest,
  ) {
    this.pcmSr = req.sampleRate ?? 24000;
  }

  async *run(): AsyncGenerator<TtsStreamEvent> {
    const providerVoice = this.req.voice.providerVoice;
    if (!providerVoice) {
      yield { type: 'error', code: 'permanent_unsupported_voice_kind',
              message: 'qwen-tts (dashscope) requires a provider voice handle' };
      return;
    }

    const url = wsHostFromConfig(this.config.baseUrl).replace(/\/$/, '')
              + `/api-ws/v1/realtime?model=${encodeURIComponent(this.req.model)}`;
    const queue = new EventQueue<TtsStreamEvent>();
    const startedAt = Date.now();
    let firstByteMs = 0;
    // 累积裸 PCM,以便所有 delta 到齐后包 WAV 头。
    // Qwen-TTS 总是交付 audio/L16(裸 PCM)- 我们转成 WAV,前端无需自定义解码器即可播放。
    const pcmChunks: Buffer[] = [];
    let pcmBytes = 0;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
    } catch (err) {
      yield { type: 'error', code: 'transient_network', message: (err as Error).message };
      return;
    }

    let aborted = false;
    const abortHandler = (): void => {
      aborted = true;
      try { ws.close(1000, 'aborted'); } catch { /* ignore */ }
      queue.close();
    };
    this.req.abortSignal?.addEventListener('abort', abortHandler);

    const voice  = this.req.voice;
    const pcmSr  = this.pcmSr;

    const audioFormat = audioFormatForSampleRate(pcmSr);

    ws.on('open', () => {
      const sessionConfig: Record<string, unknown> = {
        voice:           providerVoice.value,
        response_format: audioFormat,
        sample_rate:     pcmSr,
        mode:            'commit',
      };

      ws.send(JSON.stringify({
        type:     'session.update',
        event_id: makeEventId(),
        session:  sessionConfig,
      }));
      ws.send(JSON.stringify({
        type:     'input_text_buffer.append',
        event_id: makeEventId(),
        text:     this.req.text,
      }));
      ws.send(JSON.stringify({
        type:     'input_text_buffer.commit',
        event_id: makeEventId(),
      }));
    });

    ws.on('message', (data) => {
      if (aborted) return;

      let msg: { type?: string; delta?: string; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch { return; }

      switch (msg.type) {
        case 'response.audio.delta': {
          if (typeof msg.delta !== 'string') break;
          const chunk = Buffer.from(msg.delta, 'base64');
          pcmBytes += chunk.byteLength;
          if (pcmBytes > 16 * 1024 * 1024) {
            queue.closeWith({
              type: 'error',
              code: 'resource_exhausted',
              message: 'qwen-tts sentence exceeded the 16MiB PCM buffer limit',
            });
            try { ws.close(1009, 'audio too large'); } catch { /* ignore */ }
            break;
          }
          if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
          pcmChunks.push(chunk);
          break;
        }
        case 'response.done': {
          // 音频完成 - 发 session.finish 优雅关闭
          ws.send(JSON.stringify({ type: 'session.finish', event_id: makeEventId() }));
          break;
        }
        case 'session.finished': {
          // 把累积的 PCM 包进 WAV 容器,作为一个 chunk emit。
          const pcm    = Buffer.concat(pcmChunks);
          const wav    = pcmToWav(pcm, pcmSr);
          const bytes  = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
          queue.push({ type: 'audio_chunk', bytes, mime: 'audio/wav' });
          queue.push({ type: 'done', totalBytes: pcm.length, firstByteMs });
          queue.close();
          try { ws.close(1000, 'bye'); } catch { /* ignore */ }
          break;
        }
        case 'error': {
          queue.closeWith({
            type:    'error',
            code:    msg.error?.message?.toLowerCase().includes('auth')
                     ? 'permanent_credentials' : 'transient_server',
            message: msg.error?.message ?? 'qwen-tts realtime error',
          });
          try { ws.close(1000, 'error'); } catch { /* ignore */ }
          break;
        }
        // session.created / session.updated / response.created / response.output_item.added
        // 是生命周期事件,无消费者对应 - 忽略
        default:
          break;
      }
    });

    ws.on('error', (err) => {
      if (aborted) return;
      queue.closeWith({ type: 'error', code: 'transient_network', message: err.message });
    });

    ws.on('close', (code) => {
      if (!queue.hasFinal() && !aborted) {
        queue.closeWith({
          type: 'error',
          code: classifyCloseCode(code),
          message: `qwen-tts ws closed (${code})`,
        });
      }
    });

    try {
      yield* queue.iterate();
    } finally {
      this.req.abortSignal?.removeEventListener('abort', abortHandler);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
  }
}

// ── Qwen Realtime 音频格式选择 ───────────────────────────────────────────────

function audioFormatForSampleRate(sr: number): string {
  // 阿里文档:AudioFormat 枚举 - PCM_{rate}HZ_MONO_16BIT
  if (sr === 16000) return 'pcm';   // 服务器接受简单的 "pcm" 别名
  if (sr === 24000) return 'pcm';
  if (sr === 48000) return 'pcm';
  return 'pcm';
}

function defaultSampleRate(format: string): number {
  if (format === 'pcm') return 24000;
  if (format === 'wav') return 22050;
  return 22050;
}

function makeEventId(): string {
  return `event_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
}
