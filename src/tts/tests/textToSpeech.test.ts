// 测试 tts 包两个创建入口的冻结校验、请求校验与 HTTP 协议的合成流对账。
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { TtsError } from '../errors.js';
import { createTtsCall, createTtsVoiceRegistrar } from '../textToSpeech.js';
import type { TtsStreamEvent, TtsVoice, TtsVoiceReference } from '../types.js';

const REFERENCE: TtsVoiceReference = {
  kind: 'reference',
  audioPath: 'voice/refs/main.wav',
  promptText: '参考文本',
  promptLanguage: 'zh',
};

const PROVIDER_VOICE: TtsVoice = { kind: 'provider', id: 'voice-1', lifetime: 'ephemeral' };

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
  for await (const event of stream) events.push(event);
  return events;
}

describe('创建点冻结校验', () => {
  it('空 modelId 在两个创建点都直接抛 TypeError', () => {
    const connection = { protocol: 'openai-tts', apiKey: 'k' } as const;
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

  it('非法 sampleRate 与 speed 抛 invalid_request', () => {
    expect(() => call({ text: '好', voice: REFERENCE, sampleRate: 0 })).toThrow(/sampleRate/);
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

  it('OpenAI 注册在参考音频不可读时抛 reference_audio_missing（不发起网络请求）', async () => {
    const registrar = createTtsVoiceRegistrar(
      { protocol: 'openai-tts', apiKey: 'k', baseUrl: 'http://127.0.0.1:1' },
      'tts-model',
    );
    await expect(registrar({ ...REFERENCE, audioPath: 'D:/ema-definitely-missing/ref.wav' }))
      .rejects.toMatchObject({ code: 'tts/reference_audio_missing' });
  });
});

describe('合成流', () => {
  it('OpenAI 载荷使用创建点冻结的模型，音频块与 done 字节对账一致', async () => {
    await withServer(
      (_body, response) => {
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        response.write(Buffer.alloc(10 * 1024, 1));
        response.end(Buffer.alloc(100, 2));
      },
      async (baseUrl, captured) => {
        const callTts = createTtsCall({ protocol: 'openai-tts', apiKey: 'k', baseUrl }, 'tts-model-x');
        const events = await collect(callTts({ text: '你好呀', voice: PROVIDER_VOICE }));

        const payload = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        expect(payload.model).toBe('tts-model-x');
        expect(payload.input).toBe('你好呀');
        expect(payload.voice).toBe('voice-1');
        expect(payload.response_format).toBe('mp3');

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

  it('GPT-SoVITS 载荷携带参考音频字段且不含模型字段', async () => {
    await withServer(
      (_body, response) => {
        response.writeHead(200, { 'content-type': 'audio/wav' });
        response.end(Buffer.alloc(500, 3));
      },
      async (baseUrl, captured) => {
        const callTts = createTtsCall({ protocol: 'gpt-sovits-tts', baseUrl }, 'local-unused');
        const events = await collect(callTts({ text: '本地合成一句', voice: REFERENCE, format: 'wav' }));

        const payload = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>;
        expect(payload.ref_audio_path).toBe(REFERENCE.audioPath);
        expect(payload.prompt_text).toBe(REFERENCE.promptText);
        expect('model' in payload).toBe(false);

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
        const callTts = createTtsCall({ protocol: 'openai-tts', apiKey: 'bad', baseUrl }, 'tts-model-x');
        await expect(collect(callTts({ text: '你好', voice: PROVIDER_VOICE })))
          .rejects.toMatchObject({ code: 'tts/credentials' });
      },
    );
  });
});
