import { randomUUID } from 'node:crypto';
import fs   from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

import type { TtsAdapter, TtsProviderConfig, TtsProbeResult, TtsRequest, TtsStreamEvent, TtsErrorCode } from '../types.js';

// ── DashScope (Aliyun百炼) TTS ──────────────────────────────────────────────
//
// One adapter, two WS protocols routed by model prefix:
//
//   - cosyvoice-*        → wss://{host}/api-ws/v1/inference/
//                          actions: run-task → continue-task → finish-task
//                          audio: binary frames
//                          control: text JSON frames
//
//   - qwen*-tts*         → wss://{host}/api-ws/v1/realtime?model={model}
//                          flow:    session.update → input_text_buffer.append
//                                   → input_text_buffer.commit → response.done
//                                   → session.finish → session.finished
//                          audio: base64 in `response.audio.delta.delta`
//
// Both protocols deliver per-call audio over a single WS connection. We do
// NOT pool / reuse connections in V1 — one synthesize() = one WS.
// Connection pooling is a documented阿里 best practice for high-concurrency
// (object pool, 1.5-2x peak QPS) but桌宠 is single-user, ~1 QPS peak.

const HOST_DEFAULT = 'wss://dashscope.aliyuncs.com';

export class DashscopeTtsAdapter implements TtsAdapter {
  readonly protocol = 'dashscope-tts' as const;

  constructor(private readonly config: TtsProviderConfig) {}

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
   * Upload a local reference audio file to DashScope for voice cloning.
   * Returns the provider-assigned voice ID to store in VoiceUriCache.
   *
   * Protocol routing:
   *   cosyvoice-*  → model=voice-enrollment,      input.url
   *   qwen*-tts*   → model=qwen-voice-enrollment,  input.audio.data
   *
   * Audio transport: the file is base64-encoded and sent as a data URI.
   * DashScope docs show https:// URLs, but data URIs work in practice.
   * If a future DashScope update rejects data URIs, switch to a two-step
   * approach: first upload the file via the compatible-mode Files API
   * (POST /compatible-mode/v1/files) to get a hosted URL, then use that URL.
   */
  async uploadVoice(
    refAudioPath: string,
    _promptText:  string,
    _promptLang:  string,
    model:        string,
  ): Promise<string> {
    const family = dashscopeModelFamily(model);
    if (family === 'unknown') {
      throw new Error(`dashscope-tts: uploadVoice not supported for model "${model}"`);
    }

    // Read local file and encode as data URI for API transport.
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
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`dashscope voice enrollment failed (${resp.status}): ${text}`);
    }

    // CosyVoice response: { output: { voice_id: "prefix-xxxx" } }
    // Qwen-TTS response:  { output: { voice: "name-xxxx" } }
    const json   = await resp.json() as Record<string, unknown>;
    const output = json['output'] as Record<string, unknown> | undefined;
    const voiceId = (output?.['voice_id'] ?? output?.['voice']) as string | undefined;

    if (!voiceId) {
      throw new Error(
        `dashscope voice enrollment: unexpected response shape — ${JSON.stringify(json)}`,
      );
    }

    return voiceId;
  }

  async probe(): Promise<TtsProbeResult> {
    // DashScope uses WebSocket; probe via their REST models API instead.
    const url = 'https://dashscope.aliyuncs.com/api/v1/models';
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok || res.status === 404) return { ok: true, latencyMs };
      const text = await res.text().catch(() => '');
      return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

// ── Model family detection ──────────────────────────────────────────────────

export function dashscopeModelFamily(model: string): 'cosyvoice' | 'qwen-tts' | 'unknown' {
  if (model.startsWith('cosyvoice')) return 'cosyvoice';
  if (model.startsWith('qwen') && model.includes('tts')) return 'qwen-tts';
  return 'unknown';
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function wsHostFromConfig(baseUrl: string): string {
  // baseUrl in provider config is HTTPS-form (https://dashscope.aliyuncs.com).
  // Convert to WSS for both protocols.
  if (baseUrl.startsWith('wss://') || baseUrl.startsWith('ws://')) return baseUrl;
  if (baseUrl.startsWith('https://')) return 'wss://' + baseUrl.slice('https://'.length);
  if (baseUrl.startsWith('http://')) return 'ws://' + baseUrl.slice('http://'.length);
  return HOST_DEFAULT;
}

function httpHostFromConfig(baseUrl: string): string {
  // Inverse of wsHostFromConfig — needed for REST enrollment API calls.
  if (baseUrl.startsWith('https://') || baseUrl.startsWith('http://')) return baseUrl;
  if (baseUrl.startsWith('wss://')) return 'https://' + baseUrl.slice('wss://'.length);
  if (baseUrl.startsWith('ws://')) return 'http://' + baseUrl.slice('ws://'.length);
  return 'https://dashscope.aliyuncs.com';
}

async function* errorOnce(code: TtsErrorCode, message: string): AsyncGenerator<TtsStreamEvent> {
  yield { type: 'error', code, message };
}

// ── PCM → WAV conversion ──────────────────────────────────────────────────────
//
// Wraps raw 16-bit signed LE mono PCM into a standard RIFF/WAV container so
// browsers can play it without additional codec negotiation.
// Only called for Qwen-TTS which always delivers audio/L16 over its WS protocol.

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

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/opus';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

function classifyCloseCode(code: number): TtsErrorCode {
  if (code === 1000) return 'unknown';            // normal close
  if (code === 1006) return 'transient_network';  // abnormal close (network)
  if (code === 1008) return 'permanent_bad_request'; // policy violation
  if (code === 4001 || code === 4003) return 'permanent_credentials';
  return 'transient_server';
}

// ── Event-driven queue: bridges ws callbacks → AsyncIterable ───────────────
//
// Used by both session classes. The pattern: WS handlers push() events into
// the queue, the consumer awaits dequeue(). On close, finalize() unblocks
// any pending dequeue with a sentinel.

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

  /** Push a final value and mark stream closed. */
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

  // Silence "unused" — kept for future debugging / abort flow inspection.
  hasFinal(): boolean { return this.closeValue !== null; }
}

// ── CosyVoice session ───────────────────────────────────────────────────────
//
// Wire protocol per阿里 docs:
//   1. Open WS to /api-ws/v1/inference/ with `Authorization: bearer <key>`
//   2. Send run-task → wait for task-started event
//   3. Send continue-task with text → server sends binary audio frames
//   4. Send finish-task → wait for task-finished → close
//
// V1 clone-only: voice.voiceUri carries the provider-side voice ID from
// voice enrollment (声音复刻). uploadVoice() will be implemented later.

class CosyVoiceSession {
  private readonly mime: string;

  constructor(
    private readonly config: TtsProviderConfig,
    private readonly req:    TtsRequest,
  ) {
    this.mime = mimeForFormat(req.format ?? 'mp3');
  }

  async *run(): AsyncGenerator<TtsStreamEvent> {
    if (!this.req.voice.voiceUri) {
      yield { type: 'error', code: 'permanent_unsupported_voice_kind',
              message: 'cosyvoice (dashscope) requires voiceUri (voice not yet uploaded)' };
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
            voice:       voice.voiceUri,
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
        // Audio frame
        const buf = data as Buffer;
        if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
        totalBytes += buf.length;
        queue.push({ type: 'audio_chunk', bytes: new Uint8Array(buf), mime: this.mime });
        return;
      }

      // Text frame — JSON event
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch { return; }

      const event = msg.header?.event;
      switch (event) {
        case 'task-started': {
          // Send continue-task with full text (single segment for V1 — coordinator already split sentences)
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
          // result-generated and other intermediate events — ignore
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
// Wire protocol per阿里 docs:
//   1. Open WS to /api-ws/v1/realtime?model=<model> with `Authorization: Bearer <key>`
//   2. Send session.update with voice + response_format + mode='commit'
//   3. Send input_text_buffer.append, then input_text_buffer.commit
//   4. Server sends response.audio.delta (base64) + response.done
//   5. Send session.finish → wait for session.finished → close

class QwenTtsRealtimeSession {
  private readonly pcmSr: number;

  constructor(
    private readonly config: TtsProviderConfig,
    private readonly req:    TtsRequest,
  ) {
    this.pcmSr = req.sampleRate ?? 24000;
  }

  async *run(): AsyncGenerator<TtsStreamEvent> {
    if (!this.req.voice.voiceUri) {
      yield { type: 'error', code: 'permanent_unsupported_voice_kind',
              message: 'qwen-tts (dashscope) requires voiceUri (voice not yet uploaded)' };
      return;
    }

    const url = wsHostFromConfig(this.config.baseUrl).replace(/\/$/, '')
              + `/api-ws/v1/realtime?model=${encodeURIComponent(this.req.model)}`;
    const queue = new EventQueue<TtsStreamEvent>();
    const startedAt = Date.now();
    let firstByteMs = 0;
    // Accumulate raw PCM so we can wrap it in a WAV header after all deltas arrive.
    // Qwen-TTS always delivers audio/L16 (raw PCM) — we convert to WAV so the
    // frontend can play it without a custom decoder.
    const pcmChunks: Buffer[] = [];

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
        voice:           voice.voiceUri,
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
          if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
          pcmChunks.push(chunk);
          break;
        }
        case 'response.done': {
          // Audio complete — send session.finish to gracefully close
          ws.send(JSON.stringify({ type: 'session.finish', event_id: makeEventId() }));
          break;
        }
        case 'session.finished': {
          // Wrap accumulated PCM into a WAV container and emit as one chunk.
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
        // are lifecycle events with no consumer-facing equivalent — ignored
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

// ── Qwen Realtime audio format selection ───────────────────────────────────

function audioFormatForSampleRate(sr: number): string {
  // Per阿里 docs: AudioFormat enum — PCM_{rate}HZ_MONO_16BIT
  if (sr === 16000) return 'pcm';   // server accepts simple "pcm" alias
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
