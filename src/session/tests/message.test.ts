// 测试数据库消息 JSON 的角色校验与损坏内容安全降级。
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
    expect(parseMessageBlocksJson(JSON.stringify(reference), 'user')).toEqual(reference);
  });

  it('保留 Skill 引用的稳定身份、调用名与资源目录', () => {
    const reference = {
      type: 'skill_ref',
      skillKey: 'project:source:pdf',
      name: 'PDF',
      callName: 'pdf',
      rootPath: 'D:/project/.agents/skills/pdf',
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
