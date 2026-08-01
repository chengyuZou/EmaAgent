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
    const presentations = [
      {
        kind: 'file_change', operation: 'update', filePath: 'a.ts', unifiedDiff: 'diff',
        additions: 1, deletions: 1, truncated: false,
      },
      {
        kind: 'file_read', filePath: 'a.ts', status: 'content', startLine: 1,
        endLine: 10, totalLines: 20, partial: true, truncated: false,
      },
      {
        kind: 'pdf_read', filePath: 'a.pdf', startPage: 1, endPage: 2,
        totalPages: 4, hasMore: true, incompletePages: 0,
      },
      {
        kind: 'command', command: 'pnpm test', workingDirectory: 'D:/repo', exitCode: 0,
        timedOut: false, aborted: false, truncated: false,
      },
      {
        kind: 'search', operation: 'content_search', pattern: 'SessionStore',
        searchPath: 'src', resultCount: 3, truncated: true, limitReason: 'results',
      },
      {
        kind: 'background_process', backgroundProcessId: 'process-1', command: 'pnpm dev',
        workingDirectory: 'D:/repo', status: 'running',
      },
    ];
    const rawBlocks = presentations.map((presentation, index) => ({
      type: 'tool_result',
      toolUseId: `call-${index}`,
      content: 'done',
      durationMs: 12,
      errorCode: 'tool/error',
      presentation,
    }));

    expect(parseMessageBlocksJson(JSON.stringify(rawBlocks), 'user', 'tool_results'))
      .toEqual(rawBlocks);
  });

  it('拒绝字段不完整或枚举未知的工具展示数据', () => {
    const invalid = [{
      type: 'tool_result',
      toolUseId: 'call-1',
      content: 'done',
      presentation: {
        kind: 'command',
        command: 'pnpm test',
        workingDirectory: 'D:/repo',
        exitCode: 0,
        timedOut: false,
        aborted: false,
      },
    }];

    expect(parseMessageBlocksJson(JSON.stringify(invalid), 'user', 'tool_results'))
      .toBe('[消息内容无法读取]');
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
