// 测试数据库消息 JSON 的角色校验、Narrative 结构和损坏内容安全降级。
import { describe, expect, it } from 'vitest';
import { parseMessageBlocksJson } from '../message.js';

describe('parseMessageBlocksJson', () => {
  it('接受不含附件正文的稳定引用', () => {
    const reference = [{
      type: 'attachment_ref',
      attachmentId: 'attachment-1',
      name: 'map.png',
      mimeType: 'image/png',
    }];
    expect(parseMessageBlocksJson(JSON.stringify(reference), 'user', 'normal')).toEqual(reference);
  });
  it('保留 Session 独有的工具展示字段', () => {
    const blocks = parseMessageBlocksJson(JSON.stringify([{
      type: 'tool_result',
      toolUseId: 'call-1',
      content: 'done',
      durationMs: 12,
      errorCode: 'tool/error',
      presentation: {
        kind: 'file_change',
        operation: 'update',
        filePath: 'a.ts',
        unifiedDiff: 'diff',
        additions: 1,
        deletions: 1,
        truncated: false,
      },
    }]), 'user', 'tool_results');

    expect(blocks).toEqual([expect.objectContaining({
      durationMs: 12,
      errorCode: 'tool/error',
      presentation: expect.objectContaining({ kind: 'file_change' }),
    })]);
  });

  it('拒绝与 assistant 角色不匹配的 user block', () => {
    expect(parseMessageBlocksJson(
      JSON.stringify([{ type: 'image_url', url: 'https://example.com/a.png' }]),
      'assistant',
      'normal',
    )).toBe('[消息内容无法读取]');
  });

  it('损坏 JSON 不再把原始数据库内容展示给用户', () => {
    expect(parseMessageBlocksJson('{private-json', 'user', 'normal'))
      .toBe('[消息内容无法读取]');
  });

  it('只接受完整的 Narrative 持久化结构', () => {
    expect(parseMessageBlocksJson(JSON.stringify({
      timelines: [{ name: '1st_Loop', charCount: 4, text: 'plot' }],
    }), 'user', 'narrative_context')).toEqual({
      timelines: [{ name: '1st_Loop', charCount: 4, text: 'plot' }],
    });
  });
});
