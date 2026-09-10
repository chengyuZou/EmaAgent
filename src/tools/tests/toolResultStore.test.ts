// 测试工具结果按 UTF-8 单项预算异步外置, 同时保持磁盘失败时不丢正文。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolResultStore } from '../results/toolResultStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: ToolResultStore; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-results-'));
  temporaryDirectories.push(directory);
  return { store: new ToolResultStore(directory), directory };
}

describe('工具结果预算', () => {
  it('超过单项预算时保存完整正文并返回持久化预览', async () => {
    const { store, directory } = createStore();
    const content = '结果'.repeat(30_000);
    const normalized = await store.normalize('McpTool', content, 1024);

    expect(normalized).toContain('<persisted-output>');
    const [fileName] = fs.readdirSync(directory);
    expect(fileName).toMatch(/\.txt$/u);
    expect(fs.readFileSync(path.join(directory, fileName), 'utf8')).toBe(content);
  });

  it('短预览按 UTF-8 字节截断且不会切断 emoji', async () => {
    const { store } = createStore();
    const normalized = await store.normalize('McpTool', `A${'😀'.repeat(600)}`, 32);

    expect(normalized).toContain(`A${'😀'.repeat(499)}\n...`);
    expect(normalized).not.toContain('�');
  });

  it('预览优先停在预算后半段的完整行', async () => {
    const { store } = createStore();
    const firstLine = 'a'.repeat(1_200);
    const normalized = await store.normalize(
      'McpTool',
      `${firstLine}\n${'b'.repeat(1_200)}`,
      32,
    );

    expect(normalized).toContain(`${firstLine}\n...`);
    expect(normalized).not.toContain('bbbb');
  });

  it('空输出返回明确占位且不建立结果文件', async () => {
    const { store, directory } = createStore();

    expect(await store.normalize('Bash', '   ', 32))
      .toBe('(Bash completed with no output)');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('外置目录不可写时保留本轮完整正文', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tool-results-file-'));
    temporaryDirectories.push(root);
    const filePath = path.join(root, 'not-a-directory');
    fs.writeFileSync(filePath, 'occupied');
    const store = new ToolResultStore(filePath);
    const content = '结果'.repeat(1_000);

    expect(await store.normalize('Bash', content, 32)).toBe(content);
  });

  it('拒绝无法表达为安全字节上限的参数', async () => {
    const { store } = createStore();

    await expect(store.normalize('Bash', 'text', -1)).rejects.toThrow(RangeError);
    await expect(store.normalize('Bash', 'text', 1.5)).rejects.toThrow(RangeError);
  });
});
