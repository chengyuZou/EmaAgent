import { describe, expect, it } from 'vitest';
import { assertProtocolInput } from '../protocolInput.js';

describe('assertProtocolInput', () => {
  it('拒绝 Chat Completions 文件块并报告准确位置', () => {
    expect(() => assertProtocolInput('openai-llm', [{
      role: 'user',
      content: [{
        type: 'file_data',
        data: 'base64',
        mimeType: 'application/pdf',
      }],
    }])).toThrow(expect.objectContaining({
      name: 'LLMProtocolInputError',
      messageIndex: 0,
      blockIndex: 0,
      contentType: 'file_data',
    }));
  });

  it('允许转换器能完整表达的 OpenAI 工具图片', () => {
    expect(() => assertProtocolInput('openai-responses-llm', [{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: 'call-1',
        content: [{ type: 'image_url', url: 'https://example.test/a.png' }],
      }],
    }])).not.toThrow();
  });

  it('允许 Gemini 的图片、音频和文件内联输入', () => {
    expect(() => assertProtocolInput('gemini-llm', [{
      role: 'user',
      content: [
        { type: 'image_data', data: 'a', mimeType: 'image/png' },
        { type: 'audio_data', data: 'b', mimeType: 'audio/wav' },
        { type: 'file_data', data: 'c', mimeType: 'application/pdf' },
      ],
    }])).not.toThrow();
  });
});
