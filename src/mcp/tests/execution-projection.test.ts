// 测试 MCP 结果投影:text/image/resource/audio/structuredContent/_meta 各归其位。
import { describe, expect, it } from 'vitest';
import { projectMcpToolOutput } from '../execution.js';

describe('MCP 结果模型投影', () => {
  it('text 块原样通过', () => {
    expect(projectMcpToolOutput({
      content: [{ type: 'text', text: 'hello' }],
    })).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('image 块转 image_data 内容块', () => {
    expect(projectMcpToolOutput({
      content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
    })).toEqual([{ type: 'image_data', data: 'QUJD', mimeType: 'image/png' }]);
  });

  it('resource 文本块加来源前缀,blob 按 mime 分流', () => {
    const parts = projectMcpToolOutput({
      content: [
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } },
        { type: 'resource', resource: { uri: 'file:///p.png', blob: 'QUJD', mimeType: 'image/png' } },
        { type: 'resource', resource: { uri: 'file:///a.pdf', blob: 'QUJD', mimeType: 'application/pdf' } },
      ],
    });
    expect(parts[0]).toEqual({ type: 'text', text: '[Resource from file:///a.txt]\nbody' });
    expect(parts[1]).toEqual({ type: 'image_data', data: 'QUJD', mimeType: 'image/png' });
    expect(parts[2]?.type).toBe('text');
    expect((parts[2] as { text: string }).text).toContain('resource blob omitted');
  });

  it('audio 与未知块只给说明文本', () => {
    const parts = projectMcpToolOutput({
      content: [
        { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
        { type: 'video', data: 'QUJD' },
      ],
    });
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('audio content omitted');
    expect((parts[1] as { text: string }).text).toContain('unsupported content block type "video"');
  });

  it('structuredContent 稳定 JSON 化追加在 content 之后', () => {
    const parts = projectMcpToolOutput({
      content: [{ type: 'text', text: 'summary' }],
      structuredContent: { total: 42, items: ['a'] },
    });
    expect(parts[0]).toEqual({ type: 'text', text: 'summary' });
    expect(parts[1]).toEqual({
      type: 'text',
      text: JSON.stringify({ total: 42, items: ['a'] }, null, 2),
    });
  });

  it('_meta 绝不进入模型投影', () => {
    const parts = projectMcpToolOutput({
      content: [{ type: 'text', text: 'visible' }],
      meta: { 'io.example/secret': 'do-not-send' },
    });
    expect(JSON.stringify(parts)).not.toContain('do-not-send');
  });

  it('空结果给出显式占位文本', () => {
    expect(projectMcpToolOutput({ content: [] })).toEqual([
      { type: 'text', text: '(empty result)' },
    ]);
  });
});
