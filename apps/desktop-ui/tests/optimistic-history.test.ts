// 测试附件-only用户气泡的创建以及按 Turn 对账时不会重复或丢失。
import { describe, expect, it } from 'vitest';

import {
  createOptimisticUserMessage,
  reconcileLoadedHistory,
  type ChatHistoryItem,
} from '../src/stores/conversation-history.js';

const TURN_1 = 'turn-1';
const TURN_2 = 'turn-2';

describe('optimistic user history', () => {
  it('为附件-only请求创建带 Turn 身份的用户消息', () => {
    const item = createOptimisticUserMessage(TURN_1, '', [{
      id: 'attachment-1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      mtime: 123,
      fileHandle: 'ema-file:v1:test-handle',
    }], 100);

    expect(item).toMatchObject({
      role: 'user',
      content: '',
      turnId: TURN_1,
      createdAt: 100,
    });
    expect(item.attachments).toHaveLength(1);
  });

  it('服务端返回相同 Turn 后用持久化消息替换乐观消息', () => {
    const optimistic = createOptimisticUserMessage(TURN_1, 'hello', undefined, 100);
    const persisted: ChatHistoryItem = {
      role: 'user',
      content: 'hello',
      createdAt: 101,
      turnId: TURN_1,
      messageId: 'message-1',
    };

    const result = reconcileLoadedHistory([persisted], [optimistic]);

    expect(result).toEqual([persisted]);
  });

  it('服务端尚未返回某个 Turn 时保留对应乐观消息', () => {
    const pending = createOptimisticUserMessage(TURN_2, '', undefined, 200);
    const loaded: ChatHistoryItem = {
      role: 'user',
      content: 'older',
      createdAt: 100,
      turnId: TURN_1,
      messageId: 'message-1',
    };

    expect(reconcileLoadedHistory([loaded], [pending])).toEqual([loaded, pending]);
  });
});
