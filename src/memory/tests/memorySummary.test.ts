// 验证 Memory 摘要的读取空闸门和 Token 裁剪.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTextTokens } from '@ema-agent/token';
import { describe, expect, it } from 'vitest';
import {
  readMemorySummary,
  truncateMemorySummary,
} from '../common/memorySummary.js';

async function summaryFile(content: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-summary-'));
  const file = path.join(directory, 'memory_summary.md');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

describe('readMemorySummary', () => {
  it('returns trimmed Markdown without interpreting its first line', async () => {
    const file = await summaryFile('用户自定义首行\n\n- 条目 A\n');
    await expect(readMemorySummary(file, 2_500)).resolves.toBe(
      '用户自定义首行\n\n- 条目 A',
    );
  });

  it('returns no contribution for missing or empty files', async () => {
    const missing = path.join(os.tmpdir(), `missing-${randomUUID()}.md`);
    await expect(readMemorySummary(missing, 2_500)).resolves.toBeUndefined();
    await expect(readMemorySummary(await summaryFile(' \n'), 2_500))
      .resolves.toBeUndefined();
  });
});

describe('truncateMemorySummary', () => {
  it('keeps the result inside the Token budget and marks truncation', () => {
    const content = Array.from(
      { length: 4_000 },
      (_, index) => `条目 ${index} 的中文内容`,
    ).join('\n');
    const result = truncateMemorySummary(content, 500);

    expect(result).toContain('记忆摘要已截断');
    expect(estimateTextTokens(result)).toBeLessThanOrEqual(500);
  });

  it('does not leave a partial Unicode surrogate pair', () => {
    const result = truncateMemorySummary('😀'.repeat(1_000), 100);
    const marker = result.indexOf('\n\n<!--');
    const body = marker === -1 ? result : result.slice(0, marker);
    const lastCodeUnit = body.charCodeAt(body.length - 1);

    expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
  });
});
