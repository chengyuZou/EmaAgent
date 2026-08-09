// 测试视觉 JSON 解析与普通文本降级，不把格式偏差误判为整次识别失败。
import { describe, expect, it } from 'vitest';
import { parseVisionResult } from '../parse.js';

describe('parseVisionResult', () => {
  it('解析结构化文本、markdown 与布局块', () => {
    expect(parseVisionResult(JSON.stringify({
      text: 'Invoice total: 42',
      markdown: 'Invoice total: **42**',
      blocks: [{
        id: 'title',
        kind: 'text',
        text: 'Invoice',
        bbox: [0, 0, 1, 0.1],
        confidence: 0.9,
      }],
    }))).toEqual({
      text: 'Invoice total: 42',
      markdown: 'Invoice total: **42**',
      blocks: [{
        id: 'title',
        kind: 'text',
        text: 'Invoice',
        bbox: [0, 0, 1, 0.1],
        confidence: 0.9,
      }],
    });
  });

  it('把 fenced JSON 与普通 OCR 文本都保留成可用结果', () => {
    expect(parseVisionResult('```json\n{"text":"hello","blocks":[]}\n```').blocks)
      .toEqual([{ id: 'block-1', kind: 'text', text: 'hello' }]);
    expect(parseVisionResult('plain OCR text')).toEqual({
      text: 'plain OCR text',
      blocks: [{ id: 'block-1', kind: 'text', text: 'plain OCR text' }],
    });
  });
});
