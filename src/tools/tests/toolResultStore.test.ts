// 测试工具结果按 UTF-8 单项预算和并行聚合预算外置，同时保持失败时不丢正文。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolResultStore, generatePreview } from '../results/toolResultStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(aggregateMaxBytes = 200 * 1024): ToolResultStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-results-'));
  temporaryDirectories.push(directory);
  return new ToolResultStore(directory, aggregateMaxBytes);
}

describe('工具结果 UTF-8 预览', () => {
  it('按真实字节截断中文，不把字节上限误当字符数量', () => {
    const result = generatePreview('中文测试内容', 7);

    expect(result).toEqual({ preview: '中文', hasMore: true });
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(7);
  });

  it('不会切断四字节 emoji', () => {
    const result = generatePreview('A😀B', 4);

    expect(result).toEqual({ preview: 'A', hasMore: true });
    expect(result.preview).not.toContain('�');
  });

  it('优先在预算后半段的完整换行处截断', () => {
    expect(generatePreview('第一行\n第二行很长', 17)).toEqual({
      preview: '第一行',
      hasMore: true,
    });
  });

  it('拒绝无法表达为安全字节上限的参数', () => {
    expect(() => generatePreview('text', -1)).toThrow(RangeError);
    expect(() => generatePreview('text', 1.5)).toThrow(RangeError);
  });
});

describe('工具结果预算', () => {
  it('超过单项预算时保存完整正文并返回持久化预览', () => {
    const store = createStore();
    const content = '结果'.repeat(30_000);
    const normalized = store.normalize('call-1', 'McpTool', content, 1024);

    expect(normalized.kind).toBe('offloaded');
    if (normalized.kind !== 'offloaded') throw new Error('expected offloaded result');
    expect(normalized.blockContent).toContain('<persisted-output>');
    expect(fs.readFileSync(normalized.filePath, 'utf8')).toBe(content);
  });

  it('同一 Tool Call 重放只在正文一致时复用既有文件', () => {
    const store = createStore();
    const firstContent = '第一次结果'.repeat(1_000);
    const replayed = store.normalize('call-replay', 'Bash', firstContent, 32);
    const duplicate = store.normalize('call-replay', 'Bash', firstContent, 32);
    const conflicting = store.normalize(
      'call-replay',
      'Bash',
      '不同结果'.repeat(1_000),
      32,
    );

    expect(replayed.kind).toBe('offloaded');
    expect(duplicate.kind).toBe('offloaded');
    expect(conflicting).toEqual({ kind: 'unchanged' });
    if (replayed.kind !== 'offloaded') throw new Error('expected offloaded result');
    expect(fs.readFileSync(replayed.filePath, 'utf8')).toBe(firstContent);
  });

  it('既有结果文件不可读时保留本轮完整正文，不返回失真的持久化引用', () => {
    const store = createStore();
    const content = '结果'.repeat(1_000);
    const first = store.normalize('call-unreadable', 'Bash', content, 32);
    expect(first.kind).toBe('offloaded');
    if (first.kind !== 'offloaded') throw new Error('expected offloaded result');

    // 用同名目录稳定制造 EEXIST + 读取失败，避免依赖平台权限位或修改 ESM 内建模块。
    fs.rmSync(first.filePath);
    fs.mkdirSync(first.filePath);

    expect(store.normalize('call-unreadable', 'Bash', content, 32))
      .toEqual({ kind: 'unchanged' });
  });

  it('多个结果合计超限时优先外置最大的可外置结果', () => {
    const store = createStore(3_000);
    const contents = store.enforceAggregateBudget([
      { callId: 'small', toolName: 'Small', content: 'a'.repeat(500), maxResultBytes: 1_000 },
      { callId: 'large', toolName: 'Large', content: 'b'.repeat(4_000), maxResultBytes: 5_000 },
    ]);

    expect(contents.get('small')).toBe('a'.repeat(500));
    expect(contents.get('large')).toContain('<persisted-output>');
  });

  it('Infinity 表示工具自行封顶，聚合预算也不会把结果外置', () => {
    const store = createStore(10);
    const contents = store.enforceAggregateBudget([
      { callId: 'read', toolName: 'Read', content: 'content', maxResultBytes: Infinity },
      { callId: 'other', toolName: 'Other', content: '12345', maxResultBytes: 50 },
    ]);

    expect(contents.get('read')).toBe('content');
  });
});
