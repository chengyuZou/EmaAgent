// 测试数据库消息 JSON 的角色校验与损坏内容安全降级。
import { describe, expect, it } from 'vitest';
import { parseMessageBlocksJson } from '../message.js';

describe('parseMessageBlocksJson', () => {
  it('接受三类附件块: 纯路径引用 + 图片可选原名 + 粘贴文本预览', () => {
    const blocks = [
      {
        type: 'image_reference',
        path: 'D:/data/sessions/s1/attachments/images/a.png',
        name: '报告截图.png',
      },
      {
        type: 'pasted_text_reference',
        path: 'D:/data/sessions/s1/attachments/pasted/b.txt',
        preview: '前五百字符的定格预览',
      },
      { type: 'file_reference',        path: 'D:/docs/map.pdf' },
    ];
    expect(parseMessageBlocksJson(JSON.stringify(blocks), 'user')).toEqual(blocks);
  });

  it('拒绝缺 path 的附件块与缺 preview 的粘贴块', () => {
    expect(parseMessageBlocksJson(
      JSON.stringify([{ type: 'image_reference' }]), 'user',
    )).toBe('[消息内容无法读取]');
    expect(parseMessageBlocksJson(
      JSON.stringify([{ type: 'pasted_text_reference', path: 'D:/x.txt' }]), 'user',
    )).toBe('[消息内容无法读取]');
  });

  it('保留 Skill 引用的稳定身份', () => {
    const reference = {
      type: 'skill_reference',
      name: 'pdf',
      path: 'D:\\workspace\\.agents\\skills\\pdf\\SKILL.md',
    };
    expect(parseMessageBlocksJson(JSON.stringify([reference]), 'user')).toEqual([reference]);
  });

  it('保留 Session 需要持久化的工具终态字段', () => {
    const rawBlocks = [0, 1].map((index) => ({
      type: 'tool_result',
      toolCallId: `call-${index}`,
      content: 'done',
      durationMs: 12,
      errorCode: 'tool/error',
    }));

    expect(parseMessageBlocksJson(JSON.stringify(rawBlocks), 'user'))
      .toEqual(rawBlocks);
  });

  it('拒绝类型错误的工具终态字段', () => {
    const invalid = [{
      type: 'tool_result',
      toolCallId: 'call-1',
      content: 'done',
      durationMs: 'slow',
    }];

    expect(parseMessageBlocksJson(JSON.stringify(invalid), 'user'))
      .toBe('[消息内容无法读取]');
  });

  it('拒绝与 assistant 角色不匹配的 user block', () => {
    expect(parseMessageBlocksJson(
      JSON.stringify([{ type: 'image_url', url: 'https://example.com/a.png' }]),
      'assistant',
    )).toBe('[消息内容无法读取]');
  });

  it('损坏 JSON 不再把原始数据库内容展示给用户', () => {
    expect(parseMessageBlocksJson('{private-json', 'user'))
      .toBe('[消息内容无法读取]');
  });
});
