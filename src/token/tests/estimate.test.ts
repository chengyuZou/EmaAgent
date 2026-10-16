import { describe, expect, it } from 'vitest';
import type { LlmTool, Message } from '@ema-agent/llm';
import { estimateMessagesTokens, estimateTextTokens } from '../index.js';

describe('本地 Token 估算', () => {
  it('区分纯文本和消息格式开销, 空输入返回零', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateMessagesTokens([])).toBe(0);
    expect(estimateTextTokens('abcd你好')).toBe(3);
    expect(estimateTextTokens('😀')).toBe(2);
    expect(estimateMessagesTokens([{ role: 'user', content: 'abcd你好' }])).toBe(13);
  });

  it('顶层图片, 音频和文件缺少信息时使用固定估算', () => {
    const messages: readonly Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '请分析附件' },
        { type: 'image_data', data: 'base64', mimeType: 'image/png' },
        { type: 'audio_data', data: 'base64', mimeType: 'audio/mpeg' },
        { type: 'file_data', data: 'base64', mimeType: 'application/pdf' },
      ],
    }];
    expect(estimateMessagesTokens(messages)).toBe(
      10 + estimateTextTokens('请分析附件') + 5_334 + 8_000 + 8_000,
    );
  });

  it('按明确的媒体尺寸, 时长和页数估算', () => {
    expect(estimateMessagesTokens([{
      role: 'user',
      content: [
        { type: 'image_url', url: 'https://example.com/image.png', width: 750, height: 750 },
        { type: 'audio_data', data: 'base64', mimeType: 'audio/wav', durationMs: 10_000 },
        { type: 'file_url', url: 'https://example.com/file.pdf', mimeType: 'application/pdf', pageCount: 3 },
      ],
    }])).toBe(10 + 750 + 320 + 6_000);
  });

  it('工具定义和工具结果图片计入总数, 分开估算后相加与整体估算一致', () => {
    const messages: readonly Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: 'call-1',
        content: [{ type: 'image_data', data: 'base64', mimeType: 'image/png' }],
      }],
    }];
    const tools: readonly LlmTool[] = [{
      name: 'Read',
      description: '读取指定文件并返回内容',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }];
    const toolTokens = 20 + estimateTextTokens(JSON.stringify({
      name: tools[0]!.name,
      description: tools[0]!.description,
      parameters: tools[0]!.inputSchema,
    }));
    expect(estimateMessagesTokens(messages)).toBe(10 + 5_334);
    expect(estimateMessagesTokens([], tools)).toBe(toolTokens);
    expect(estimateMessagesTokens(messages, tools)).toBe(10 + 5_334 + toolTokens);
  });
});
