// 多站点并发刷新与更新对账编排。
import type { SkillRow } from '@ema-agent/storage';
import { installSkillFromSite, type InstallDeps } from '../../installer/install.js';
import { fetchSiteIndex, type SiteFetchResult } from './siteClient.js';
import type { SkillSiteIndex, SkillSiteStore } from './siteStore.js';

/** 站点级拉取函数;测试注入替身,生产默认走 siteClient。 */
export type SiteIndexFetchFn = (site: Parameters<typeof fetchSiteIndex>[0]) => Promise<SiteFetchResult>;

export interface SiteRefreshReport {
  readonly siteId: string;
  readonly outcome: 'notModified' | 'updated' | 'failed';
  /** outcome=failed 时的原因;不阻断其他站点。 */
  readonly error?: string;
}

// refreshSites 属 SKILL-1(依赖 siteStore/siteClient 完成),骨架保留在文件尾。

export interface SkillUpdateCandidate {
  /** skills 表稳定 id(也是 user key 的后缀)。 */
  readonly skillId: string;
  readonly siteId: string;
  readonly siteEntryId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly bundleUrl: string;
  readonly bundleSha256: string;
  readonly sizeBytes: number;
}

export interface OfflineReconcileResult {
  /** 索引 version 比已装新的候选。 */
  readonly updates: SkillUpdateCandidate[];
  /** 站点索引里已没有对应条目的已装技能 id(标记"来源已移除",不自动删除)。 */
  readonly removedSources: string[];
}

export interface OfflineReconcileInput {
  /** skills 表中带 site_id 的行(调用方 listBySite 或全量过滤)。 */
  readonly installed: readonly SkillRow[];
  /** 站点缓存索引(只读 SQL 缓存,零网络)。 */
  readonly sites: readonly { siteId: string; index: SkillSiteIndex | null }[];
}

/** 启动对账:只用 SQL 缓存索引比对 version,零网络。 */
export function reconcileUpdatesOffline(input: OfflineReconcileInput): OfflineReconcileResult {
  const indexBySite = new Map(input.sites.map((site) => [site.siteId, site.index]));
  const updates: SkillUpdateCandidate[] = [];
  const removedSources: string[] = [];

  for (const row of input.installed) {
    if (!row.site_id || !row.site_entry_id) continue;
    const index = indexBySite.get(row.site_id);
    if (!index) continue;
    const entry = index.skills.find((candidate) => candidate.id === row.site_entry_id);
    if (!entry) {
      removedSources.push(row.id);
      continue;
    }
    if (entry.version !== row.version) {
      updates.push({
        skillId: row.id,
        siteId: row.site_id,
        siteEntryId: row.site_entry_id,
        fromVersion: row.version,
        toVersion: entry.version,
        bundleUrl: entry.bundleUrl,
        bundleSha256: entry.bundleSha256,
        sizeBytes: entry.sizeBytes,
      });
    }
  }
  return { updates, removedSources };
}

/**
 * 应用更新:并发上限 3 的 worker 池;同一技能的串行由安装链按 key 保证。
 * 单候选失败只记录,不影响其他候选。
 */
export async function applySkillUpdates(
  candidates: readonly SkillUpdateCandidate[],
  deps: InstallDeps,
  concurrency = 3,
): Promise<{ updated: string[]; failed: { skillId: string; error: string }[] }> {
  const updated: string[] = [];
  const failed: { skillId: string; error: string }[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      try {
        await installSkillFromSite({
          siteId: candidate.siteId,
          entry: {
            id: candidate.siteEntryId,
            name: candidate.siteEntryId,
            description: '',
            version: candidate.toVersion,
            bundleUrl: candidate.bundleUrl,
            bundleSha256: candidate.bundleSha256,
            sizeBytes: candidate.sizeBytes,
          },
        }, deps);
        updated.push(candidate.skillId);
      } catch (error) {
        failed.push({
          skillId: candidate.skillId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
  return { updated, failed };
}

/**
 * 多站点并发刷新(上限 4,单站失败不影响他站):
 *   304 → 只刷新拉取时间;200 → 校验+覆盖缓存;失败 → 记状态,旧缓存保留。
 * 调用方在刷新成功后做更新对账;auto_update=1 的站点随后调 applySkillUpdates。
 */
export async function refreshSites(deps: {
  store: SkillSiteStore;
  fetchIndex?: SiteIndexFetchFn;
}): Promise<SiteRefreshReport[]> {
  const fetchIndex = deps.fetchIndex ?? fetchSiteIndex;
  const sites = deps.store.listEnabled();
  const reports: SiteRefreshReport[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < sites.length) {
      const site = sites[cursor++]!;
      try {
        const result = await fetchIndex(site);
        if (result.kind === 'notModified') {
          deps.store.touchFetched(site.id);
          reports.push({ siteId: site.id, outcome: 'notModified' });
        } else if (result.kind === 'ok') {
          deps.store.saveFetchSuccess(site.id, result.index, result.etag, result.lastModified);
          reports.push({ siteId: site.id, outcome: 'updated' });
        } else {
          deps.store.saveFetchFailure(site.id, result.error);
          reports.push({ siteId: site.id, outcome: 'failed', error: result.error });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.store.saveFetchFailure(site.id, message);
        reports.push({ siteId: site.id, outcome: 'failed', error: message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, sites.length) }, () => worker()));
  return reports;
}
