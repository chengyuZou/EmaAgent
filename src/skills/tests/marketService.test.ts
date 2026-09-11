// 验证市场聚合结果不会把同一正式技能身份重复交给前端。
import { describe, expect, it } from 'vitest';
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
