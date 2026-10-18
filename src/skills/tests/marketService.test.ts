import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketService } from '../sources/market/marketService.js';
import {
  marketSkillId,
  type MarketAdapter,
  type MarketSkill,
  type MarketSource,
} from '../sources/market/types.js';

describe('market service list', () => {
  it('去除单一来源返回的重复技能身份', async () => {
    const duplicate = skill('skillhub', 'smart-charts');
    const service = createMarketService({
      userRoot: 'Z:\\ema-market-test-not-installed',
      adapters: {
        skillhub: adapter('skillhub', [duplicate, duplicate]),
        clawhub: adapter('clawhub', []),
      },
    });

    const result = await service.list({ source: 'all', limit: 24 });

    expect(result.items.map(item => item.id)).toEqual(['skillhub:smart-charts']);
  });

  it('使用来源身份标记识别已安装技能, 不要求版本或统计字段', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'ema-skill-market-'));
    try {
      const item = skill('skillhub', 'identity-marker');
      const directory = join(userRoot, item.slug);
      await mkdir(directory);
      await writeFile(join(directory, '.ema-market.json'), JSON.stringify({
        id: item.id,
        source: item.source,
        slug: item.slug,
      }));
      await writeFile(join(directory, 'SKILL.md'), '---\nname: identity-marker\n---\nInstructions');
      const service = createMarketService({
        userRoot,
        adapters: {
          skillhub: adapter('skillhub', [item]),
          clawhub: adapter('clawhub', []),
        },
      });

      const result = await service.list({ source: 'skillhub', q: item.slug, limit: 24 });

      expect(result.items).toEqual([{ ...item, installState: 'installed' }]);
    } finally {
      await rm(userRoot, { recursive: true, force: true });
    }
  });
});

function skill(source: MarketSource, slug: string): MarketSkill {
  return {
    id: marketSkillId(source, slug),
    source,
    slug,
    name: slug,
    summary: '',
    downloads: 1,
    tags: [],
    installState: 'installable',
  };
}

function adapter(source: MarketSource, items: MarketSkill[]): MarketAdapter {
  return {
    source,
    async list() {
      return { items };
    },
    async search() {
      return { items };
    },
    async detail() {
      throw new Error('本测试不读取详情');
    },
    async listFiles() {
      return [];
    },
    async fetchFile() {
      throw new Error('本测试不读取文件');
    },
  };
}
