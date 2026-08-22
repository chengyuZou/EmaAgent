// 验证 JSONL 增量读取能跨 UTF-8 分块，并拒绝没有完整落盘的末行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJsonlRecord, readJsonl } from '../records/jsonl.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('jsonl', () => {
  it('逐行读取 UTF-8 记录', async () => {
    const file = temporaryFile();
    fs.writeFileSync(file, Buffer.concat([
      encodeJsonlRecord({ text: '艾玛' }),
      encodeJsonlRecord({ text: '第二行' }),
    ]));
    const values: unknown[] = [];
    for await (const value of readJsonl(file, input => input)) values.push(value);
    expect(values).toEqual([{ text: '艾玛' }, { text: '第二行' }]);
  });

  it('拒绝缺少换行符的末行', async () => {
    const file = temporaryFile();
    fs.writeFileSync(file, '{"id":1}', 'utf8');
    await expect(async () => {
      for await (const _ of readJsonl(file, input => input)) { /* 消费生成器。 */ }
    }).rejects.toThrow('最后一行缺少换行符');
  });
});

function temporaryFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-jsonl-'));
  roots.push(root);
  return path.join(root, 'records.jsonl');
}
