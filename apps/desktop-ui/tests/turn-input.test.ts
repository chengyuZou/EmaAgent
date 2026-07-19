// 测试文字、结构化内容和附件三种 Turn 输入使用同一有效性规则。
import { describe, expect, it } from 'vitest';

import { hasTurnRequestInput } from '@ema-agent/contracts';

describe('hasTurnRequestInput', () => {
  it('允许只携带本地附件引用的请求', () => {
    expect(hasTurnRequestInput({
      attachments: [{
        id: 'attachment-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        mtime: 123,
        fileHandle: 'ema-file:v1:test-handle',
      }],
    })).toBe(true);
  });

  it('允许文字或结构化内容并拒绝真正的空请求', () => {
    expect(hasTurnRequestInput({ userInput: 'hello' })).toBe(true);
    expect(hasTurnRequestInput({ contentParts: [{ type: 'text', text: 'hello' }] })).toBe(true);
    expect(hasTurnRequestInput({ userInput: '   ', attachments: [] })).toBe(false);
  });
});
