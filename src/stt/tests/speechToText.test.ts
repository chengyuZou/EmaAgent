// 测试 STT 公共入口的 multipart 请求、响应映射、输入校验和单次调用语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeechToText } from '../speechToText.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('SpeechToText', () => {
  it('发送 OpenAI multipart 请求并把秒转换为毫秒', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      text: '你好',
      segments: [{ start: 0.25, end: 1.5, text: '你好' }],
    }), { status: 200 }));
    const stt = createSpeechToText({
      protocol: 'openai-stt',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1/',
    });

    await expect(stt.transcribe({
      model: 'whisper-1',
      audio: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
      language: 'zh',
    })).resolves.toEqual({
      text: '你好',
      segments: [{ startMs: 250, endMs: 1_500, text: '你好' }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/audio/transcriptions');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('空音频在访问 Provider 前失败', async () => {
    const stt = createSpeechToText({ protocol: 'openai-stt' });
    await expect(stt.transcribe({
      model: 'whisper-1', audio: new Uint8Array(), mimeType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'stt/invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('损坏的分段时间显式失败', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      text: 'bad',
      segments: [{ start: 2, end: 1, text: 'bad' }],
    }), { status: 200 }));
    const stt = createSpeechToText({ protocol: 'openai-stt' });

    await expect(stt.transcribe({
      model: 'whisper-1', audio: new Uint8Array([1]), mimeType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'stt/invalid_response' });
  });

  it('429 原样失败，不在包内重试', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    const stt = createSpeechToText({ protocol: 'openai-stt' });

    await expect(stt.transcribe({
      model: 'whisper-1', audio: new Uint8Array([1]), mimeType: 'audio/wav',
    })).rejects.toMatchObject({ code: 'stt/http_error', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
