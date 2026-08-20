// 验证 Memory 字节统计,存储边界和单次操作预算.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureMemoryStorageBytes } from '../capacity/measureStorageBytes.js';
import {
  DEFAULT_MEMORY_STORAGE_LIMIT,
  evaluateMemoryStorage,
} from '../capacity/storageLimit.js';
import { DEFAULT_MEMORY_BUDGETS } from '../capacity/budgets.js';
import { memoryBudgetsGroup } from '../settings.js';

describe('Memory capacity', () => {
  it('counts nested files and Git data but not directory entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ema-memory-capacity-'));
    await fs.mkdir(path.join(root, 'work', '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(root, 'work', 'MEMORY.md'), 'abc', 'utf8');
    await fs.writeFile(path.join(root, 'work', '.git', 'objects', 'one'), '12345', 'utf8');

    await expect(measureMemoryStorageBytes(root)).resolves.toBe(8);
    await expect(measureMemoryStorageBytes(path.join(root, 'missing'))).resolves.toBe(0);
  });

  it('reports normal, warning and hard limit states', () => {
    const limit = { maxBytes: 100, warningAtBytes: 80 };

    expect(evaluateMemoryStorage(79, limit)).toMatchObject({
      level: 'normal',
      remainingBytes: 21,
    });
    expect(evaluateMemoryStorage(80, limit)).toMatchObject({
      level: 'warning',
      remainingBytes: 20,
    });
    expect(evaluateMemoryStorage(100, limit)).toMatchObject({
      level: 'limitExceeded',
      remainingBytes: 0,
    });
  });

  it('derives the fixed warning line and keeps evidence inside consolidation input', () => {
    expect(DEFAULT_MEMORY_STORAGE_LIMIT.warningAtBytes).toBe(
      Math.floor(DEFAULT_MEMORY_STORAGE_LIMIT.maxBytes * 0.8),
    );
    expect(DEFAULT_MEMORY_BUDGETS.turnEvidenceFileBytes).toBeLessThanOrEqual(
      DEFAULT_MEMORY_BUDGETS.consolidationInputBytes,
    );

    const invalid = Object.fromEntries(
      memoryBudgetsGroup.definitions.map((definition) => [
        definition.key,
        definition.defaultValue,
      ]),
    );
    invalid['memory.budgets.turnEvidenceFileBytes'] = 2 * 1024 * 1024;
    invalid['memory.budgets.consolidationInputBytes'] = 1024 * 1024;

    expect(memoryBudgetsGroup.schema.safeParse(invalid).success).toBe(false);
  });
});
