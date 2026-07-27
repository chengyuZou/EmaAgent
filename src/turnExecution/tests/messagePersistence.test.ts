// 测试模型可见的 Base64 媒体不会原样落库，附件只保存稳定引用。

import { describe, expect, it } from 'vitest';
import { buildPersistedUserInput } from '../turnPreparation.js';

describe('Message 媒体持久化投影', () => {
  it('移除临时 Base64 并保留附件引用和普通文本', () => {
    const blocks = buildPersistedUserInput([
      {
        type: 'image_data',
        data: 'very-large-base64',
        mimeType: 'image/png',
        name: 'map.png',
      },
      { type: 'text', text: '请分析图片' },
    ], [{
      id: 'attachment-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      name: 'map.png',
      mime: 'image/png',
      size: 123,
      mtime: 1,
      localPath: 'D:\\data\\map.png',
      createdAt: 2,
    }]);

    expect(JSON.stringify(blocks)).not.toContain('very-large-base64');
    expect(blocks).toContainEqual({ type: 'text', text: '请分析图片' });
    expect(blocks).toContainEqual({
      type: 'attachment_ref',
      attachmentId: 'attachment-1',
      name: 'map.png',
      mimeType: 'image/png',
    });
  });
});
