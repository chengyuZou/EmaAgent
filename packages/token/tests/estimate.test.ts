// 测试 LLM 输入预算不会漏掉顶层媒体、工具定义和工具结果中的图片。
import { describe, expect, it } from 'vitest';
import type { Message as ModelMessage } from '@ema-agent/llm';
import {
  estimateLlmInputTokens,
  estimateMessagesTokens,
} from '../src/index.js';

describe('结构化 Token 估算', () => {
  it('顶层图片、音频和文件都占用预算，未知媒体信息会留下诊断', () => {
    const messages: ModelMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '请分析附件' },
        { type: 'image_data', data: 'base64', mimeType: 'image/png' },
        { type: 'audio_data', data: 'base64', mimeType: 'audio/mpeg' },
        { type: 'file_data', data: 'base64', mimeType: 'application/pdf' },
      ],
    }];

    const estimate = estimateLlmInputTokens(messages);

    expect(estimate.breakdown.imageTokens).toBeGreaterThan(0);
    expect(estimate.breakdown.audioTokens).toBeGreaterThan(0);
    expect(estimate.breakdown.documentTokens).toBeGreaterThan(0);
    expect(estimate.warnings).toEqual([
      'imageDimensionsUnknown',
      'audioDurationUnknown',
      'documentPageCountUnknown',
    ]);
    expect(estimateMessagesTokens(messages)).toBe(estimate.totalTokens);
  });

  it('使用明确媒体信息缩小保守上界', () => {
    const estimate = estimateLlmInputTokens([{
      role: 'user',
      content: [
        { type: 'image_url', url: 'https://example.com/image.png', width: 750, height: 750 },
        { type: 'audio_data', data: 'base64', mimeType: 'audio/wav', durationMs: 10_000 },
        { type: 'file_url', url: 'https://example.com/file.pdf', mimeType: 'application/pdf', pageCount: 3 },
      ],
    }]);

    expect(estimate.breakdown.imageTokens).toBe(750);
    expect(estimate.breakdown.audioTokens).toBe(320);
    expect(estimate.breakdown.documentTokens).toBe(6_000);
    expect(estimate.warnings).toEqual([]);
  });

  it('工具定义和工具结果图片进入同一个输入预算', () => {
    const withoutTools = estimateLlmInputTokens([{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'call-1',
        content: [{ type: 'image_data', data: 'base64', mimeType: 'image/png' }],
      }],
    }]);
    const withTools = estimateLlmInputTokens([{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'call-1',
        content: [{ type: 'image_data', data: 'base64', mimeType: 'image/png' }],
      }],
    }], {
      tools: [{
        name: 'Read',
        description: '读取指定文件并返回内容',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
    });

    expect(withoutTools.breakdown.imageTokens).toBeGreaterThan(0);
    expect(withTools.breakdown.toolDefinitionTokens).toBeGreaterThan(0);
    expect(withTools.totalTokens).toBeGreaterThan(withoutTools.totalTokens);
  });
});
