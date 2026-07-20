import { describe, expect, it } from 'vitest';
import type { Message } from '@ema-agent/llm';
import {
  prepareHistoricalMessageView,
  validateCurrentContent,
} from '../messageCompatibility.js';
import type { ModelCapabilitySnapshot } from '@ema-agent/provider';

const TEXT_ONLY: ModelCapabilitySnapshot = {
  input: {
    text: 'supported',
    image: 'unsupported',
    audio: 'unsupported',
    file: 'unsupported',
  },
  tools: 'supported',
  reasoning: 'unsupported',
  temperature: 'supported',
  source: 'catalog',
};

describe('LLM 消息兼容请求视图', () => {
  it('只替换历史媒体，不修改原始 Session 消息对象', () => {
    const original: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '请看图片' },
        { type: 'image_data', data: 'base64', mimeType: 'image/png', name: 'cat.png' },
        { type: 'file_data', data: 'base64', mimeType: 'application/pdf', filename: 'a.pdf' },
      ],
    }];
    const before = structuredClone(original);

    const view = prepareHistoricalMessageView(original, TEXT_ONLY);

    expect(original).toEqual(before);
    expect(view.messages).not.toBe(original);
    expect(view.messages[0]).not.toBe(original[0]);
    expect(view.actions.map((action) => action.modality)).toEqual(['image', 'file']);
    expect(view.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '请看图片' },
        { type: 'text', text: expect.stringContaining('历史图片“cat.png”未发送') },
        { type: 'text', text: expect.stringContaining('历史附件“a.pdf”未发送') },
      ],
    }]);
  });

  it('本轮媒体在 unsupported 和 unknown 时都 fail-closed', () => {
    const image = [{ type: 'image_data' as const, data: 'x', mimeType: 'image/png' }];
    expect(validateCurrentContent(image, TEXT_ONLY)).toMatchObject([
      { modality: 'image', state: 'unsupported' },
    ]);

    const unknown: ModelCapabilitySnapshot = {
      ...TEXT_ONLY,
      input: { ...TEXT_ONLY.input, image: 'unknown' },
      source: 'unknown',
    };
    expect(validateCurrentContent(image, unknown)).toMatchObject([
      { modality: 'image', state: 'unknown' },
    ]);
  });

  it('保留历史中已有的文字描述，仅替换原始媒体块', () => {
    const original: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: '图片描述：一只黑猫坐在窗边。' },
        { type: 'image_data', data: 'base64', mimeType: 'image/png' },
      ],
    }];

    const view = prepareHistoricalMessageView(original, TEXT_ONLY);

    expect(view.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '图片描述：一只黑猫坐在窗边。' },
        { type: 'text', text: expect.stringContaining('历史图片未发送') },
      ],
    });
  });

  it('递归替换历史 tool_result 中的图片并保持工具结果结构', () => {
    const original: Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'call-1',
        content: [
          { type: 'text', text: '截图结果' },
          { type: 'image_data', data: 'base64', mimeType: 'image/png' },
        ],
      }],
    }];

    const view = prepareHistoricalMessageView(original, TEXT_ONLY);

    expect(view.actions).toMatchObject([
      { messageIndex: 0, partIndex: 0, nestedPartIndex: 1, modality: 'image' },
    ]);
    expect(view.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'call-1',
        content: [
          { type: 'text', text: '截图结果' },
          { type: 'text', text: expect.stringContaining('历史图片未发送') },
        ],
      }],
    }]);
  });
});
