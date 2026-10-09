import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { TtsError } from '../errors.js';
import { createTtsCall, createTtsVoiceRegistrar } from '../textToSpeech.js';
import type { TtsStreamEvent, TtsVoice, TtsVoiceReference } from '../types.js';
import { gptSoVitsWavEvents, packPcmWav } from '../audio/wav.js';
import { pcmEvents } from '../audio/pcm.js';

const REFERENCE: TtsVoiceReference = {
  kind: 'reference',
  resourceName: 'main.wav',
  resourceUpdatedAt: 1,
  registrationName: 'ema-2d3a9570-8e68-4c15-a11f-9fa58f38a912',
  audioPath: 'voice/refs/main.wav',
  promptText: '参考文本',
  promptLanguage: 'zh',
};

const PROVIDER_VOICE: TtsVoice = { kind: 'provider', id: 'voice-1' };

function wavFixture(pcm: Buffer, sampleRate: number, channelCount = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channelCount * 2, 28);
  header.writeUInt16LE(channelCount * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface CapturedRequest {
  readonly body: string;
}

/** 起 127.0.0.1 随机端口的捕获服务器：记录请求体，按 handler 流式回包。 */
async function withServer(
  handler: (body: string, response: http.ServerResponse) => void,
  run: (baseUrl: string, captured: readonly CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      captured.push({ body });
      handler(body, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
}

async function collect(stream: AsyncIterable<TtsStreamEvent>): Promise<TtsStreamEvent[]> {
  const events: TtsStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function audioBytes(events: readonly TtsStreamEvent[]): Buffer {
  const chunks = events.filter(event => event.type === 'audio_chunk');
  return Buffer.concat(chunks.map(event => Buffer.from(event.bytes)));
}

describe('创建点冻结校验', () => {
  it('空 modelId 在两个创建点都直接抛 TypeError', () => {
    const connection = { protocol: 'siliconflow-tts', apiKey: 'k' } as const;
    expect(() => createTtsCall(connection, '  ')).toThrow(TypeError);
    expect(() => createTtsVoiceRegistrar(connection, '')).toThrow(TypeError);
  });

  it('DashScope 无法识别的模型在创建点抛 unsupported_model', () => {
    const connection = { protocol: 'dashscope-tts', apiKey: 'k' } as const;
    try {
      createTtsCall(connection, 'gpt-4o');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TtsError);
      expect((error as TtsError).code).toBe('tts/unsupported_model');
    }
  });

  it('DashScope 两个模型族都能正常创建', () => {
    const connection = { protocol: 'dashscope-tts', apiKey: 'k' } as const;
    expect(typeof createTtsCall(connection, 'cosyvoice-v2')).toBe('function');
    expect(typeof createTtsVoiceRegistrar(connection, 'qwen3-tts-flash')).toBe('function');
  });
});

describe('请求校验', () => {
  const call = createTtsCall({ protocol: 'gpt-sovits-tts', baseUrl: 'http://127.0.0.1:1' }, 'local');

  it('空文本抛 invalid_request', () => {
    expect(() => call({ text: '  ', voice: REFERENCE })).toThrow(/text must not be empty/);
  });

  it('非法 speed 抛 invalid_request', () => {
    expect(() => call({ text: '好', voice: REFERENCE, speed: -1 })).toThrow(/speed/);
  });

  it('registrar 拒绝空参考音频路径', () => {
    const registrar = createTtsVoiceRegistrar({ protocol: 'gpt-sovits-tts' }, 'local');
    expect(() => registrar({ ...REFERENCE, audioPath: ' ' })).toThrow(/reference audio path/);
  });
});

describe('音色注册', () => {
  it('GPT-SoVITS 原样直通本地参考音频', async () => {
    const registrar = createTtsVoiceRegistrar({ protocol: 'gpt-sovits-tts', baseUrl: 'http://127.0.0.1:1' }, 'local');
    await expect(registrar(REFERENCE)).resolves.toEqual(REFERENCE);
  });

  it('SiliconFlow 注册在参考音频不可读时抛 reference_audio_missing（不发起网络请求）', async () => {
    const registrar = createTtsVoiceRegistrar(
      { protocol: 'siliconflow-tts', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' },
      'tts-model',
    );
    await expect(registrar({ ...REFERENCE, audioPath: 'D:/ema-definitely-missing/ref.wav' }))
      .rejects.toMatchObject({ code: 'tts/reference_audio_missing' });
  });

  it('SiliconFlow 使用装配层给出的注册名称且不发送 language', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ema-tts-'));
    const audioPath = join(directory, 'main.wav');
    await writeFile(audioPath, Buffer.from([1, 2, 3]));
    try {
      await withServer(
        (_body, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ uri: 'speech:ema-2d3a9570-8e68-4c15-a11f-9fa58f38a912:test' }));
        },
        async (baseUrl, captured) => {
          const registrar = createTtsVoiceRegistrar(
            { protocol: 'siliconflow-tts', apiKey: 'k', baseUrl },
            'IndexTeam/IndexTTS-2',
          );
          await expect(registrar({ ...REFERENCE, audioPath })).resolves.toEqual({
            kind: 'provider',
            id: 'speech:ema-2d3a9570-8e68-4c15-a11f-9fa58f38a912:test',
          });
          expect(captured[0]?.body).toContain('name="customName"');
          expect(captured[0]?.body).toContain(REFERENCE.registrationName);
          expect(captured[0]?.body).not.toContain('name="language"');
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('合成流', () => {
  it('SiliconFlow 载荷使用冻结模型和注册声音，并请求流式响应', async () => {
    await withServer(
      (_body, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.write(Buffer.alloc(10 * 1024, 1));
        response.end(Buffer.alloc(100, 2));
      },
      async (baseUrl, captured) => {
        const callTts = createTtsCall({ protocol: 'siliconflow-tts', apiKey: 'k', baseUrl }, 'tts-model-x');
        const events = await collect(callTts({ text: '你好呀', voice: PROVIDER_VOICE }));

        const payload: unknown = JSON.parse(captured[0]?.body ?? '{}');
        expect(payload).toMatchObject({
          model: 'tts-model-x',
          input: '你好呀',
          voice: 'voice-1',
          response_format: 'pcm',
          sample_rate: 24_000,
          stream: true,
        });
        expect(events[0]).toEqual({ type: 'audio_started', sampleRate: 24_000, channelCount: 1 });

        const totalBytes = 10 * 1024 + 100;
        const chunks = events.filter(event => event.type === 'audio_chunk');
        const chunked = chunks.reduce(
          (sum, event) => sum + (event.type === 'audio_chunk' ? event.bytes.byteLength : 0),
          0,
        );
        expect(chunked).toBe(totalBytes);
        expect(events.at(-1)).toEqual({
          type: 'done',
          totalBytes,
          firstByteMs: expect.any(Number),
        });
      },
    );
  });

  it('GPT-SoVITS 携带参考音频且不含模型字段, 保留实际 32 kHz 双声道', async () => {
    const pcm = Buffer.alloc(500, 3);
    await withServer(
      (_body, response) => {
        response.writeHead(200, { 'content-type': 'audio/wav' });
        response.end(wavFixture(pcm, 32_000, 2));
      },
      async (baseUrl, captured) => {
        const callTts = createTtsCall({ protocol: 'gpt-sovits-tts', baseUrl }, 'local-unused');
        const events = await collect(callTts({ text: '本地合成一句', voice: REFERENCE }));

        const payload: unknown = JSON.parse(captured[0]?.body ?? '{}');
        expect(payload).toMatchObject({
          ref_audio_path: REFERENCE.audioPath,
          prompt_text: REFERENCE.promptText,
          media_type: 'wav',
          streaming_mode: true,
        });
        expect(payload).not.toHaveProperty('model');
        expect(events[0]).toEqual({ type: 'audio_started', sampleRate: 32_000, channelCount: 2 });
        const chunks = events.filter(event => event.type === 'audio_chunk');
        expect(Buffer.concat(chunks.map(event => Buffer.from(event.bytes)))).toEqual(pcm);

        expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: 500 });
      },
    );
  });

  it('协议响应失败统一映射为 TtsError', async () => {
    await withServer(
      (_body, response) => {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('bad key');
      },
      async (baseUrl) => {
        const callTts = createTtsCall({ protocol: 'siliconflow-tts', apiKey: 'bad', baseUrl }, 'tts-model-x');
        await expect(collect(callTts({ text: '你好', voice: PROVIDER_VOICE })))
          .rejects.toMatchObject({ code: 'tts/credentials' });
      },
    );
  });
});

describe('PCM 与 WAV', () => {
  it('跨网络块的半个采样被拼合, 输出完整帧且无 WAV 头', async () => {
    const events = await collect(pcmEvents(Readable.from([
      Buffer.from([1]), Buffer.from([2, 3, 4, 5]), Buffer.from([6]),
    ]), { sampleRate: 24_000, channelCount: 1 }, Date.now()));
    const chunks = events.filter(event => event.type === 'audio_chunk');
    expect(chunks.every(event => event.bytes.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks.map(event => Buffer.from(event.bytes)))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: 6 });
  });

  it('截断采样不能伪装成成功流', async () => {
    await expect(collect(pcmEvents(
      Readable.from([Buffer.from([1, 2, 3])]),
      { sampleRate: 24_000, channelCount: 1 },
      Date.now(),
    )))
      .rejects.toMatchObject({ code: 'tts/invalid_response' });
  });

  it('双声道按左右各一个采样组成完整帧, 单块不超过 8 KiB', async () => {
    const pcm = Buffer.alloc(20 * 1024, 7);
    const events = await collect(pcmEvents(
      Readable.from([pcm.subarray(0, 3), pcm.subarray(3, 5), pcm.subarray(5)]),
      { sampleRate: 32_000, channelCount: 2 },
      Date.now(),
    ));
    const chunks = events.filter(event => event.type === 'audio_chunk');
    expect(chunks.every(event => event.bytes.byteLength % 4 === 0)).toBe(true);
    expect(chunks.every(event => event.bytes.byteLength <= 8 * 1024)).toBe(true);
    expect(audioBytes(events)).toEqual(pcm);
    expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: pcm.byteLength });
  });

  it('GPT-SoVITS 的零长度流式 WAV 保留 32 kHz 和原始样本', async () => {
    const pcm = Buffer.alloc(64_000, 5);
    const wav = wavFixture(pcm, 32_000);
    wav.writeUInt32LE(36, 4);
    wav.writeUInt32LE(0, 40);
    const events = await collect(gptSoVitsWavEvents(
      Readable.from([wav.subarray(0, 21), wav.subarray(21)]),
      Date.now(),
    ));
    expect(events[0]).toEqual({ type: 'audio_started', sampleRate: 32_000, channelCount: 1 });
    expect(audioBytes(events)).toEqual(pcm);
    expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: pcm.byteLength });
  });

  it('文件头、扩展 fmt 和带填充的元数据可以逐字节跨块, 不混入 PCM', async () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = wavFixture(pcm, 32_000, 2);
    const metadata = Buffer.alloc(12);
    metadata.write('LIST', 0);
    metadata.writeUInt32LE(3, 4);
    metadata.set([9, 10, 11], 8);
    const extended = Buffer.concat([
      wav.subarray(0, 36),
      Buffer.alloc(2),
      metadata,
      wav.subarray(36),
    ]);
    extended.writeUInt32LE(18, 16);
    extended.writeUInt32LE(extended.byteLength - 8, 4);
    const networkChunks: Buffer[] = [];
    for (let offset = 0; offset < extended.byteLength; offset++) {
      networkChunks.push(extended.subarray(offset, offset + 1));
    }
    const events = await collect(gptSoVitsWavEvents(Readable.from(networkChunks), Date.now()));
    expect(events[0]).toEqual({ type: 'audio_started', sampleRate: 32_000, channelCount: 2 });
    expect(audioBytes(events)).toEqual(pcm);
  });

  it('有明确 data 长度时不读取尾部元数据', async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = Buffer.concat([wavFixture(pcm, 24_000), Buffer.from('JUNKnot audio')]);
    const events = await collect(gptSoVitsWavEvents(Readable.from([wav]), Date.now()));
    expect(audioBytes(events)).toEqual(pcm);
    expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: pcm.byteLength });
  });

  it('试听 WAV 有完整长度和真实格式, 封装不改变双声道样本', async () => {
    const pcm = Buffer.alloc(4_800);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(Math.round(Math.sin(offset / 20) * 8_000), offset);
    }
    const wav = Buffer.from(packPcmWav(
      [pcm.subarray(0, 2_400), pcm.subarray(2_400)],
      { sampleRate: 32_000, channelCount: 2 },
    ));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
    expect(wav.readUInt32LE(24)).toBe(32_000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(32)).toBe(4);
    const events = await collect(gptSoVitsWavEvents(Readable.from([wav]), Date.now()));
    expect(audioBytes(events)).toEqual(pcm);
  });

  it('损坏 WAV 返回响应错误, 不伪装成音频完成', async () => {
    await expect(collect(gptSoVitsWavEvents(
      Readable.from([Buffer.from('not a RIFF WAV')]),
      Date.now(),
    ))).rejects.toMatchObject({ code: 'tts/invalid_response' });
  });

  it('拒绝压缩 WAV、非 16 位样本和不一致的帧长度', async () => {
    const compressed = wavFixture(Buffer.alloc(8), 24_000);
    compressed.writeUInt16LE(3, 20);
    const wrongBits = wavFixture(Buffer.alloc(8), 24_000);
    wrongBits.writeUInt16LE(24, 34);
    const wrongFrameSize = wavFixture(Buffer.alloc(8), 24_000, 2);
    wrongFrameSize.writeUInt16LE(2, 32);
    for (const wav of [compressed, wrongBits, wrongFrameSize]) {
      await expect(collect(gptSoVitsWavEvents(Readable.from([wav]), Date.now())))
        .rejects.toMatchObject({ code: 'tts/invalid_response' });
    }
  });

  it('文件头或已声明长度的音频未收完整时失败', async () => {
    const wav = wavFixture(Buffer.alloc(8), 24_000);
    for (const endOffset of [9, 20, 35, 43, 48]) {
      const input = Readable.from([wav.subarray(0, endOffset)]);
      await expect(collect(gptSoVitsWavEvents(input, Date.now())))
        .rejects.toMatchObject({ code: 'tts/invalid_response' });
      expect(input.destroyed).toBe(true);
    }
  });

  it('取消正在等待文件头的读取会结束输入流', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const completion = collect(gptSoVitsWavEvents(input, Date.now(), controller.signal));
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: 'tts/aborted' });
    expect(input.destroyed).toBe(true);
  });

  it('输入未结束就能读取 PCM, 提前退出会取消仍未结束的输入', async () => {
    const input = new PassThrough();
    const wav = wavFixture(Buffer.alloc(192_000), 32_000);
    wav.writeUInt32LE(0, 40);
    input.write(wav);
    // 不调用 input.end(), 音频块必须在网络 EOF 前到达.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const iterator = gptSoVitsWavEvents(input, Date.now(), controller.signal)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual({ type: 'audio_started', sampleRate: 32_000, channelCount: 1 });
      const next = await iterator.next();
      expect(next.done).toBe(false);
      expect(next.value.type).toBe('audio_chunk');
      await iterator.return?.();
      expect(input.destroyed).toBe(true);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  it('收到首个 PCM 块后取消, 不等待流式响应 EOF', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const wav = wavFixture(Buffer.from([1, 2, 3, 4]), 32_000);
    wav.writeUInt32LE(0, 40);
    input.write(wav);
    const iterator = gptSoVitsWavEvents(input, Date.now(), controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value).toMatchObject({ type: 'audio_chunk' });
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'tts/aborted' });
    expect(input.destroyed).toBe(true);
  });
});

interface SocketRequest {
  readonly type?: string;
  readonly header?: { readonly action?: string };
  readonly session?: { readonly response_format?: string; readonly sample_rate?: number };
  readonly payload?: { readonly parameters?: { readonly format?: string; readonly sample_rate?: number } };
}

async function withSocketServer(
  handle: (socket: WebSocket, request: SocketRequest) => void,
  run: (baseUrl: string, captured: SocketRequest[]) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string') throw new Error('Expected TCP socket');
  const captured: SocketRequest[] = [];
  server.on('connection', socket => {
    socket.on('message', data => {
      const request = JSON.parse(data.toString()) as SocketRequest;
      captured.push(request);
      handle(socket, request);
    });
  });
  try {
    await run(`http://127.0.0.1:${address.port}`, captured);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('DashScope PCM', () => {
  it('CosyVoice 请求 PCM 24 kHz 并交付二进制样本', async () => {
    await withSocketServer((socket, request) => {
      if (request.header?.action === 'run-task') {
        socket.send(JSON.stringify({ header: { event: 'task-started' } }));
      }
      if (request.header?.action === 'finish-task') {
        socket.send(Buffer.from([1, 2, 3, 4]));
        socket.send(JSON.stringify({ header: { event: 'task-finished' } }));
      }
    }, async (baseUrl, captured) => {
      const call = createTtsCall({ protocol: 'dashscope-tts', baseUrl, apiKey: 'test' }, 'cosyvoice-v2');
      const events = await collect(call({ text: '测试语音', voice: PROVIDER_VOICE }));
      expect(captured[0]?.payload?.parameters).toMatchObject({ format: 'pcm', sample_rate: 24_000 });
      expect(events[1]).toEqual({ type: 'audio_chunk', bytes: Buffer.from([1, 2, 3, 4]) });
      expect(events.at(-1)).toMatchObject({ type: 'done', totalBytes: 4 });
    });
  });

  it('Qwen 在 session.finished 之前交付 delta, 不整句拼接 WAV', async () => {
    await withSocketServer((socket, request) => {
      if (request.type === 'input_text_buffer.commit') {
        socket.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([1, 2, 3, 4]).toString('base64') }));
      }
      if (request.type === 'session.finish') socket.send(JSON.stringify({ type: 'session.finished' }));
    }, async (baseUrl, captured) => {
      const call = createTtsCall({ protocol: 'dashscope-tts', baseUrl, apiKey: 'test' }, 'qwen3-tts-flash-realtime');
      const iterator = call({ text: '测试语音', voice: PROVIDER_VOICE })[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'audio_started', sampleRate: 24_000 });
      expect((await iterator.next()).value).toEqual({ type: 'audio_chunk', bytes: Buffer.from([1, 2, 3, 4]) });
      expect(captured[0]?.session).toMatchObject({ response_format: 'pcm', sample_rate: 24_000 });
      expect(captured.some(request => request.type === 'session.finish')).toBe(false);
      await iterator.return?.();
    });
  });
});
