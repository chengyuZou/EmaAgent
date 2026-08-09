// 测试协议转换前会拒绝真实的不兼容输入，而不是静默删除内容。
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
      name: 'LlmProtocolInputError',
      messageIndex: 0,
      blockIndex: 0,
      contentType: 'file_data',
    }));
  });

  it('拒绝 OpenAI 函数结果里的图片', () => {
    expect(() => assertProtocolInput('openai-responses-llm', [{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: 'call-1',
        content: [{ type: 'image_url', url: 'https://example.test/a.png' }],
      }],
    }])).toThrow(expect.objectContaining({ contentType: 'image_url' }));
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
