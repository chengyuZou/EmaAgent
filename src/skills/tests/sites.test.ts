// 站点 Store 与刷新编排测试:row↔实体映射、304/成功/失败三态、单站失败不级联。
import { describe, expect, it } from 'vitest';
import type { SkillSiteInsert, SkillSiteRow, SkillSitesRepo } from '@ema-agent/storage';
import {
  parseSiteIndex,
  SkillSiteStore,
  siteIdForUrl,
  type SkillSiteIndex,
} from '../sources/sites/siteStore.js';
import { refreshSites } from '../sources/sites/refresh.js';

function makeRepo() {
  const rows = new Map<string, SkillSiteRow>();
  const repo: SkillSitesRepo = {
    insert: (row: SkillSiteInsert) => {
      rows.set(row.id, {
        enabled: 1,
        index_json: null,
        schema_version: null,
        last_fetch_at: null,
        fetch_status: 'never',
        last_error: null,
        etag: null,
        last_modified: null,
        ...row,
        enabled: row.enabled ?? 1,
      } as SkillSiteRow);
    },
    update: (id, patch) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    },
    findById: (id) => rows.get(id) ?? null,
    listAll: () => [...rows.values()],
    listEnabled: () => [...rows.values()].filter((r) => r.enabled === 1),
    deleteById: (id) => rows.delete(id),
  } as SkillSitesRepo;
  return { repo, rows };
}

const INDEX: SkillSiteIndex = {
  schemaVersion: 1,
  skippedEntries: 0,
  skills: [{
    id: 'pdf-qa',
    name: 'PDFQA',
    description: 'demo',
    version: '1.0.0',
    bundleUrl: 'https://x/pdf-qa.zip',
    bundleSha256: 'a'.repeat(64),
    sizeBytes: 100,
  }],
};

describe('SkillSiteStore', () => {
  it('create/list/update/remove 全链路;同 URL 同 id', () => {
    const { repo } = makeRepo();
    const store = new SkillSiteStore(repo);
    const site = store.create({ label: '官方', indexUrl: 'https://skills.example.com/index.json' });
    expect(site.id).toBe(siteIdForUrl('https://skills.example.com/index.json'));
    expect(site.enabled).toBe(true);

    store.update(site.id, { enabled: false });
    expect(store.get(site.id)!.enabled).toBe(false);
    expect(store.listEnabled()).toHaveLength(0);

    expect(store.remove(site.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('saveFetchSuccess 写缓存;saveFetchFailure 保留旧缓存', () => {
    const { repo } = makeRepo();
    const store = new SkillSiteStore(repo);
    const site = store.create({ label: 's', indexUrl: 'https://x/i.json' });

    store.saveFetchSuccess(site.id, INDEX, 'etag-1', null);
    const ok = store.get(site.id)!;
    expect(ok.fetchStatus).toBe('ok');
    expect(ok.index?.skills).toHaveLength(1);
    expect(ok.etag).toBe('etag-1');

    store.saveFetchFailure(site.id, 'boom');
    const failed = store.get(site.id)!;
    expect(failed.fetchStatus).toBe('failed');
    expect(failed.lastError).toBe('boom');
    expect(failed.index?.skills).toHaveLength(1);  // 旧缓存还在
  });
});

describe('parseSiteIndex — 协议校验', () => {
  it('未知字段剥离;单条失败跳过计数;整体非法抛错', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      futureField: 'x',
      skills: [
        { ...INDEX.skills[0], extra: 'drop-me' },
        { id: 'bad' },
      ],
    });
    const index = parseSiteIndex(raw);
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).not.toHaveProperty('extra');
    expect(index.skippedEntries).toBe(1);
    expect(() => parseSiteIndex('{"schemaVersion":2}')).toThrow();
  });
});

describe('refreshSites', () => {
  it('304/成功/失败三态各归其位;单站失败不级联', async () => {
    const { repo, rows } = makeRepo();
    const store = new SkillSiteStore(repo);
    const a = store.create({ label: 'a', indexUrl: 'https://a/i.json' });
    const b = store.create({ label: 'b', indexUrl: 'https://b/i.json' });
    const c = store.create({ label: 'c', indexUrl: 'https://c/i.json' });

    const reports = await refreshSites({
      store,
      fetchIndex: async (site) => {
        if (site.id === a.id) return { kind: 'notModified' };
        if (site.id === b.id) return { kind: 'ok', index: INDEX, etag: 'e2', lastModified: null };
        return { kind: 'failed', error: 'net down' };
      },
    });

    expect(reports).toHaveLength(3);
    expect(rows.get(a.id)!.last_fetch_at).not.toBeNull();
    expect(rows.get(a.id)!.index_json).toBeNull();          // 304 不动缓存
    expect(rows.get(b.id)!.fetch_status).toBe('ok');
    expect(rows.get(b.id)!.etag).toBe('e2');
    expect(rows.get(c.id)!.fetch_status).toBe('failed');
    expect(rows.get(c.id)!.last_error).toBe('net down');
  });
});
