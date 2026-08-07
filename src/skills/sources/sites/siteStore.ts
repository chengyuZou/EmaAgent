// 市场面站点实体与索引缓存:类型 + skill_sites CRUD + row↔实体显式映射。
// 站点是实体(有缓存/etag/对账),配置不进 Settings;enabled 是市场实体状态,与技能启用无关。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SkillSiteInsert, SkillSiteRow, SkillSitesRepo } from '@ema-agent/storage';

// ── 实体类型 ───────────────────────────────────────────────────────────────────

export interface SkillSite {
  id: string;
  label: string;
  indexUrl: string;
  enabled: boolean;
  builtin: boolean;
  sortOrder: number;
  autoUpdate: boolean;
  createdAt: number;
  /** 上次成功拉取的索引(缓存);未拉过或缓存损坏为 null。 */
  index: SkillSiteIndex | null;
  lastFetchAt: number | null;
  fetchStatus: 'never' | 'ok' | 'failed';
  lastError: string | null;
  etag: string | null;
  lastModified: string | null;
  updatedAt: number;
}

/** 站点索引协议(schemaVersion=1)。 */
export interface SkillSiteIndex {
  schemaVersion: number;
  skills: SkillSiteEntry[];
  /** 单条校验失败的跳过数,供 UI 提示"部分条目无法解析"。 */
  skippedEntries: number;
}

export interface SkillSiteEntry {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** 站点索引版本,安装/更新对账的唯一事实源。 */
  version: string;
  bundleUrl: string;
  bundleSha256: string;
  sizeBytes: number;
}

// ── 索引协议校验:未知字段剥离,单条失败跳过计数 ────────────────────────────────

const siteEntrySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  description: z.string().max(2_000).default(''),
  whenToUse: z.string().max(500).optional(),
  version: z.string().min(1).max(64),
  bundleUrl: z.string().url().max(2_048),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(1).max(8 * 1024 * 1024),
}).strip();

const siteIndexSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.array(z.unknown()).max(2_000),
}).strip();

/** 解析站点索引原文;整体非法抛错,单条失败跳过并计数。 */
export function parseSiteIndex(raw: string): SkillSiteIndex {
  const parsed = siteIndexSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error('站点索引协议校验失败(schemaVersion/结构不符)');
  }
  const skills: SkillSiteEntry[] = [];
  let skippedEntries = 0;
  for (const candidate of parsed.data.skills) {
    const entry = siteEntrySchema.safeParse(candidate);
    if (entry.success) skills.push(entry.data);
    else skippedEntries += 1;
  }
  return { schemaVersion: 1, skills, skippedEntries };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export interface SkillSiteCreateInput {
  label: string;
  indexUrl: string;
  autoUpdate?: boolean;
}

export class SkillSiteStore {
  constructor(private readonly repo: SkillSitesRepo) {}

  list(): SkillSite[] {
    return this.repo.listAll().map(rowToSite);
  }

  listEnabled(): SkillSite[] {
    return this.repo.listEnabled().map(rowToSite);
  }

  get(id: string): SkillSite | null {
    const row = this.repo.findById(id);
    return row ? rowToSite(row) : null;
  }

  /** id 由规范化 indexUrl 派生:同一地址重复添加撞主键,不会出双份。 */
  create(input: SkillSiteCreateInput): SkillSite {
    const id = siteIdForUrl(input.indexUrl);
    const now = Date.now();
    const insert: SkillSiteInsert = {
      id,
      label: input.label,
      index_url: input.indexUrl,
      builtin: 0,
      sort_order: 0,
      auto_update: input.autoUpdate ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    this.repo.insert(insert);
    const row = this.repo.findById(id);
    if (!row) throw new Error(`站点写入后读取失败: ${id}`);
    return rowToSite(row);
  }

  update(
    id: string,
    patch: Partial<Pick<SkillSite, 'label' | 'enabled' | 'autoUpdate' | 'sortOrder'>>,
  ): void {
    this.repo.update(id, {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      ...(patch.autoUpdate !== undefined ? { auto_update: patch.autoUpdate ? 1 : 0 } : {}),
      ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
      updated_at: Date.now(),
    });
  }

  /** builtin 站点禁删(repo 层强制);返回是否实际删除。 */
  remove(id: string): boolean {
    return this.repo.deleteById(id);
  }

  /** 拉取成功:覆盖索引缓存与条件请求凭证。 */
  saveFetchSuccess(
    id: string,
    index: SkillSiteIndex,
    etag: string | null,
    lastModified: string | null,
  ): void {
    const now = Date.now();
    this.repo.update(id, {
      index_json: JSON.stringify({ schemaVersion: index.schemaVersion, skills: index.skills }),
      schema_version: index.schemaVersion,
      last_fetch_at: now,
      fetch_status: 'ok',
      last_error: null,
      etag,
      last_modified: lastModified,
      updated_at: now,
    });
  }

  /** 拉取失败:只记状态与错误,旧缓存保留(市场页仍可秒渲染)。 */
  saveFetchFailure(id: string, error: string): void {
    this.repo.update(id, {
      last_fetch_at: Date.now(),
      fetch_status: 'failed',
      last_error: error.slice(0, 500),
      updated_at: Date.now(),
    });
  }

  /** 304 专用:只刷新拉取时间,不动索引与状态。 */
  touchFetched(id: string): void {
    this.repo.update(id, { last_fetch_at: Date.now(), updated_at: Date.now() });
  }
}

/** 同一 URL 永远同一站点 id。 */
export function siteIdForUrl(indexUrl: string): string {
  return `site_${createHash('sha256').update(indexUrl.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

function rowToSite(row: SkillSiteRow): SkillSite {
  let index: SkillSiteIndex | null = null;
  if (row.index_json) {
    try {
      index = parseSiteIndex(row.index_json);
    } catch {
      // 缓存损坏等价于没有缓存;fetch_status 按行原样展示。
      index = null;
    }
  }
  return {
    id: row.id,
    label: row.label,
    indexUrl: row.index_url,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    sortOrder: row.sort_order,
    autoUpdate: row.auto_update === 1,
    createdAt: row.created_at,
    index,
    lastFetchAt: row.last_fetch_at,
    fetchStatus: row.fetch_status === 'ok' || row.fetch_status === 'failed' ? row.fetch_status : 'never',
    lastError: row.last_error,
    etag: row.etag,
    lastModified: row.last_modified,
    updatedAt: row.updated_at,
  };
}
