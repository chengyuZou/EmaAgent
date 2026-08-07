// 离线与刷新后更新对账测试:version 比对、来源移除标记、无溯源行跳过。
import { describe, expect, it } from 'vitest';
import type { SkillRow } from '@ema-agent/storage';
import {
  reconcileUpdatesOffline,
  type OfflineReconcileInput,
} from '../sources/sites/refresh.js';

function row(overrides: Partial<SkillRow>): SkillRow {
  return {
    id: 'x',
    name: 'x',
    version: '1.0.0',
    description: '',
    arg_hint: null,
    dir_path: '/skills/x',
    source: 'user',
    source_url: null,
    sha256: null,
    site_id: null,
    site_entry_id: null,
    size_bytes: 1,
    content_mtime: 1,
    installed_at: 1,
    ...overrides,
  };
}

const INDEX = {
  schemaVersion: 1,
  skills: [
    {
      id: 'pdf-qa',
      name: 'PDFQA',
      description: '',
      version: '2.0.0',
      bundleUrl: 'https://x/pdf-qa.zip',
      bundleSha256: 'beef',
      sizeBytes: 100,
    },
  ],
};

function inputOf(installed: SkillRow[], index: typeof INDEX | null = INDEX): OfflineReconcileInput {
  return { installed, sites: [{ siteId: 'shop', index }] };
}

describe('reconcileUpdatesOffline', () => {
  it('索引 version 更新 → 候选;一致 → 静默', () => {
    const result = reconcileUpdatesOffline(inputOf([
      row({ id: 'site_shop_pdf-qa', site_id: 'shop', site_entry_id: 'pdf-qa', version: '1.0.0' }),
      row({ id: 'site_shop_other', site_id: 'shop', site_entry_id: 'other', version: '2.0.0' }),
    ]));
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({
      skillId: 'site_shop_pdf-qa',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      bundleSha256: 'beef',
    });
    // 'other' 不在索引 → 来源已移除。
    expect(result.removedSources).toEqual(['site_shop_other']);
  });

  it('无站点溯源的行与无缓存索引的站点都跳过', () => {
    const result = reconcileUpdatesOffline({
      installed: [
        row({ id: 'manual-1' }),
        row({ id: 'site_ghost_x', site_id: 'ghost', site_entry_id: 'x' }),
      ],
      sites: [{ siteId: 'shop', index: INDEX }],
    });
    expect(result.updates).toEqual([]);
    expect(result.removedSources).toEqual([]);
  });
});
