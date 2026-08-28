// 验证设置 key 的一级导航、页面分节、专属字段排除与跨域搜索。
import { describe, expect, it } from 'vitest';
import type { SettingsCatalogItem } from '../src/api/settings.js';
import { buildSettingDomains, searchSettingItems } from '../src/settings/catalog/settingCatalog.js';

function setting(key: string, label: string): SettingsCatalogItem {
  return {
    key,
    label,
    description: `${label}说明`,
    apply: 'nextOperation',
    defaultValue: 1,
    schema: { type: 'number' },
  };
}

describe('setting catalog projection', () => {
  it('用一级 key 建导航并把中间 key 建成页面 Section', () => {
    const domains = buildSettingDomains([
      setting('memory.storage.maxBytes', '存储上限'),
      setting('memory.jobs.heartbeatSeconds', '心跳间隔'),
      setting('permission.mode', '权限模式'),
    ]);

    const memory = domains.find((domain) => domain.id === 'memory');
    expect(memory?.sections.map((section) => section.id)).toEqual(['storage', 'jobs']);
    expect(domains.find((domain) => domain.id === 'permission')?.sections[0]?.id).toBe('general');
  });

  it('专属编辑字段不进入通用参数页和搜索结果', () => {
    const items = [
      setting('frontend.theme', '桌面主题'),
      setting('frontend.eventDisplay', '事件提示'),
      setting('context.compact.retainRatio', '压缩保留比例'),
    ];

    expect(buildSettingDomains(items).some((domain) => domain.id === 'frontend')).toBe(false);
    expect(searchSettingItems(items, '桌面')).toEqual([]);
    expect(searchSettingItems(items, '压缩')).toHaveLength(1);
  });
});
