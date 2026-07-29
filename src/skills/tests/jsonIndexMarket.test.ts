// 测试 JSON Skill 市场只暴露携带合法完整 Bundle SHA-256 的条目。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSourceRecord } from '@ema-agent/marketplace';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock('@ema-agent/marketplace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ema-agent/marketplace')>();
  return {
    ...original,
    fetchJson: mocks.fetchJson,
  };
});

import { list } from '../market/handlers/json-index.js';

const source: MarketSourceRecord = {
  id: 'verified-index',
  kind: 'skill',
  type: 'json-index',
  label: 'Verified Skills',
  config: JSON.stringify({ indexUrl: 'https://example.com/index.json' }),
  enabled: true,
  builtin: false,
  sortOrder: 0,
  createdAt: 1,
};

describe('Skill JSON 市场完整性清单', () => {
  beforeEach(() => {
    mocks.fetchJson.mockReset();
  });

  it('保留并规范化合法 Bundle sha256，忽略缺失或非法摘要的条目', async () => {
    mocks.fetchJson.mockResolvedValue({
      entries: [
        {
          name: 'verified',
          path: 'skills/verified',
          url: 'https://example.com/verified/SKILL.md',
          sha256: 'A'.repeat(64),
        },
        {
          name: 'missing',
          url: 'https://example.com/missing/SKILL.md',
        },
        {
          name: 'invalid',
          url: 'https://example.com/invalid/SKILL.md',
          sha256: 'not-a-sha256',
        },
      ],
    });

    await expect(list(source)).resolves.toEqual([{
      name: 'verified',
      path: 'skills/verified',
      url: 'https://example.com/verified/SKILL.md',
      sha256: 'a'.repeat(64),
    }]);
  });
});
