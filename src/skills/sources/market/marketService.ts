// 市场聚合服务:选 Adapter、两源合并分页、跨源去重、安装状态标注、文件预览。
// 缓存与来源健康在 cache.ts;安装业务在 installService.ts;本文件不解析任一市场的私有字段。
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getSourceHealth, marketCache, MARKET_TTL } from './cache.js';
import { clawhubAdapter } from './clawhubAdapter.js';
import { skillhubAdapter } from './skillhubAdapter.js';
import {
  MARKET_LIMITS,
  MARKET_META_FILENAME,
  MARKET_SOURCES,
  parseMarketMeta,
  sanitizeDirName,
  detectMarketLanguage,
  marketSkillId,
  type MarketAdapter,
  type MarketFileContent,
  type MarketListResult,
  type MarketSkill,
  type MarketSkillDetail,
  type MarketSource,
  type SourceStatusInfo,
  type AdapterListPage,
} from './types.js';

const defaultAdapters: Record<MarketSource, MarketAdapter> = {
  skillhub: skillhubAdapter,
  clawhub: clawhubAdapter,
};

export interface MarketServiceDeps {
  /** 用户技能根目录;安装状态标注按它现查(不缓存)。 */
  readonly userRoot: string;
  /** 默认真实 Adapter;测试注入替身。 */
  readonly adapters?: Record<MarketSource, MarketAdapter>;
}

export interface MarketListParams {
  readonly q?: string;
  readonly source: 'all' | MarketSource;
  readonly installed?: 'all' | 'installed' | 'installable';
  readonly cursor?: string;
  readonly limit: number;
}

export interface MarketService {
  list(params: MarketListParams): Promise<MarketListResult>;
  detail(source: MarketSource, slug: string): Promise<{ skill: MarketSkillDetail; sourceStatus: SourceStatusInfo }>;
  fileContent(source: MarketSource, slug: string, filePath: string): Promise<MarketFileContent>;
  status(): Record<MarketSource, SourceStatusInfo>;
  adapterFor(source: MarketSource): MarketAdapter;
}

// ── 合并游标(两源各自分页的不透明合并) ────────────────────────────────────────

type MergedCursor = Partial<Record<MarketSource, string>>;

function encodeCursor(cursor: MergedCursor): string | null {
  if (Object.keys(cursor).length === 0) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function decodeCursor(raw: string | undefined): MergedCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as MergedCursor;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const cursor: MergedCursor = {};
    for (const source of MARKET_SOURCES) {
      const value = parsed[source];
      if (typeof value === 'string' && value) cursor[source] = value;
    }
    return cursor;
  } catch {
    return undefined;
  }
}

// ── 安装状态标注(读目录里的 .ema-market.json) ─────────────────────────────────

/** 读技能目录里的市场溯源标记;没有或非法返回 null。 */
export async function readMarketMeta(dir: string): Promise<ReturnType<typeof parseMarketMeta>> {
  try {
    return parseMarketMeta(JSON.parse(await readFile(join(dir, MARKET_META_FILENAME), 'utf8')));
  } catch {
    return null;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

// ── 跨源去重:SkillHub 镜像条目并入 ClawHub 原始条目 ──────────────────────────

function dedupeSkills(items: MarketSkill[]): MarketSkill[] {
  const byClawhubSlug = new Map<string, MarketSkill>();
  for (const item of items) {
    if (item.source === 'clawhub') byClawhubSlug.set(item.slug, item);
  }
  const result: MarketSkill[] = [];
  for (const item of items) {
    if (item.source === 'skillhub' && item.upstream?.slug) {
      const original = byClawhubSlug.get(item.upstream.slug);
      if (original) {
        byClawhubSlug.set(item.upstream.slug, {
          ...original,
          mirrors: [...(original.mirrors ?? []), item.id],
          // 用 SkillHub 独有的字段富化原始条目。
          ...(!original.iconUrl && item.iconUrl ? { iconUrl: item.iconUrl } : {}),
          ...(!original.securityNote && item.securityNote ? { securityNote: item.securityNote } : {}),
          ...(original.tags.length === 0 && item.tags.length > 0 ? { tags: item.tags } : {}),
        });
        continue;
      }
    }
    result.push(item);
  }
  // 被富化过的原始条目替换回结果序列(保持原顺序)。
  return result.map((item) =>
    item.source === 'clawhub' ? (byClawhubSlug.get(item.slug) ?? item) : item,
  );
}

export function createMarketService(deps: MarketServiceDeps): MarketService {
  const adapters = deps.adapters ?? defaultAdapters;

  async function annotateInstallState<T extends MarketSkill>(skill: T): Promise<T> {
    const dirName = sanitizeDirName(skill.slug);
    if (!dirName) {
      return { ...skill, installState: 'not-installable', notInstallableReason: 'invalid-name' };
    }
    const target = join(deps.userRoot, dirName);
    if (!(await dirExists(target))) {
      return { ...skill, installState: 'installable' };
    }
    const meta = await readMarketMeta(target);
    if (meta && meta.id === marketSkillId(skill.source, skill.slug) && sanitizeDirName(meta.slug) === dirName) {
      return {
        ...skill,
        installState: 'installed',
        installedInfo: { version: meta.version, installedAt: meta.installedAt, dirName },
      };
    }
    // 目录存在但不是市场装的(或属于同名其他技能)——拒绝覆盖。
    return { ...skill, installState: 'not-installable', notInstallableReason: 'name-conflict' };
  }

  /** 文件级可安装检查:拿到文件清单才可能判定。 */
  function applyFileLimits(detail: MarketSkillDetail): MarketSkillDetail {
    if (detail.installState !== 'installable') return detail;
    if (detail.files.length === 0 || !detail.files.some((f) => f.path === 'SKILL.md')) {
      return { ...detail, installState: 'not-installable', notInstallableReason: 'empty-file-list' };
    }
    if (detail.files.length > MARKET_LIMITS.maxFileCount) {
      return { ...detail, installState: 'not-installable', notInstallableReason: 'too-many-files' };
    }
    if (detail.files.some((f) => f.tooBig) || detail.totalSize > MARKET_LIMITS.maxTotalSize) {
      return { ...detail, installState: 'not-installable', notInstallableReason: 'file-too-large' };
    }
    return detail;
  }

  type AdapterOutcome = { page: AdapterListPage | null; status: SourceStatusInfo };

  async function fetchAdapterPage(
    source: MarketSource,
    params: { q?: string; cursor?: string; limit: number },
  ): Promise<AdapterOutcome> {
    const isSearch = Boolean(params.q);
    const cacheKey = isSearch
      ? `search:${source}:${params.q}:${params.cursor ?? ''}:${params.limit}`
      : `list:${source}:${params.cursor ?? ''}:${params.limit}`;
    const ttl = isSearch ? MARKET_TTL.search : MARKET_TTL.list;

    const cached = marketCache.get<AdapterListPage>(cacheKey);
    if (cached) {
      return { page: cached, status: { status: 'ok', fetchedAt: Date.now(), fromCache: true } };
    }

    try {
      const page = isSearch
        ? await adapters[source].search({ q: params.q!, cursor: params.cursor, limit: params.limit })
        : await adapters[source].list({ cursor: params.cursor, limit: params.limit });
      marketCache.set(cacheKey, page, ttl);
      return { page, status: { status: 'ok', fetchedAt: Date.now(), fromCache: false } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 过期缓存兜底:上游挂了也能看到旧数据。
      const stale = marketCache.getStale<AdapterListPage>(cacheKey);
      if (stale) {
        return {
          page: stale.value,
          status: { status: 'cached', fetchedAt: stale.storedAt, fromCache: true, error: message },
        };
      }
      return { page: null, status: { ...getSourceHealth(source), fromCache: false, error: message } };
    }
  }

  return {
    adapterFor: (source) => adapters[source],

    async list(params: MarketListParams): Promise<MarketListResult> {
      const cursor = decodeCursor(params.cursor);
      const isFirstPage = !params.cursor;
      const activeSources = params.source === 'all' ? MARKET_SOURCES : [params.source];

      const outcomes = new Map<MarketSource, AdapterOutcome>();
      await Promise.all(
        activeSources.map(async (source) => {
          // 非首页游标里缺的来源 = 已穷尽。
          const adapterCursor = cursor?.[source];
          if (!isFirstPage && !adapterCursor) {
            outcomes.set(source, { page: { items: [] }, status: { status: 'ok', fromCache: true } });
            return;
          }
          const limit = params.q && source === 'clawhub' ? MARKET_LIMITS.searchResultCap : params.limit;
          outcomes.set(source, await fetchAdapterPage(source, { q: params.q, cursor: adapterCursor, limit }));
        }),
      );

      let merged: MarketSkill[] = [];
      const nextCursor: MergedCursor = {};
      const sources = {} as Record<MarketSource, SourceStatusInfo>;

      for (const source of MARKET_SOURCES) {
        const outcome = outcomes.get(source);
        if (!outcome) {
          sources[source] = { status: 'ok', fromCache: false };
          continue;
        }
        sources[source] = outcome.status;
        if (outcome.page) {
          merged.push(...outcome.page.items);
          if (outcome.page.nextCursor) nextCursor[source] = outcome.page.nextCursor;
        }
      }

      merged = dedupeSkills(merged);
      merged.sort((a, b) => b.downloads - a.downloads);
      merged = await Promise.all(merged.map((item) => annotateInstallState(item)));

      if (params.installed && params.installed !== 'all') {
        merged = merged.filter((item) =>
          params.installed === 'installed'
            ? item.installState === 'installed'
            : item.installState !== 'installed',
        );
      }

      return { items: merged, nextCursor: encodeCursor(nextCursor), sources };
    },

    async detail(source, slug) {
      const cacheKey = `detail:${source}:${slug}`;
      let detail = marketCache.get<MarketSkillDetail>(cacheKey);
      let sourceStatus: SourceStatusInfo = { status: 'ok', fetchedAt: Date.now(), fromCache: true };

      if (!detail) {
        try {
          detail = await adapters[source].detail(slug);
          marketCache.set(cacheKey, detail, MARKET_TTL.detail);
          sourceStatus = { status: 'ok', fetchedAt: Date.now(), fromCache: false };
        } catch (error) {
          const stale = marketCache.getStale<MarketSkillDetail>(cacheKey);
          if (!stale) throw error;
          detail = stale.value;
          sourceStatus = {
            status: 'cached',
            fetchedAt: stale.storedAt,
            fromCache: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const annotated = applyFileLimits(await annotateInstallState(detail));
      return { skill: annotated, sourceStatus };
    },

    async fileContent(source, slug, filePath) {
      const cacheKey = `file:${source}:${slug}:${filePath}`;
      const cached = marketCache.get<MarketFileContent>(cacheKey);
      if (cached) return cached;

      const fetched = await adapters[source].fetchFile(slug, filePath);
      let content = fetched.content;
      let truncated = false;
      if (Buffer.byteLength(content, 'utf-8') > MARKET_LIMITS.previewTruncateBytes) {
        content = Buffer.from(content, 'utf-8').subarray(0, MARKET_LIMITS.previewTruncateBytes).toString('utf-8');
        truncated = true;
      }
      const result: MarketFileContent = {
        path: filePath,
        content,
        language: detectMarketLanguage(filePath),
        size: fetched.size,
        truncated,
      };
      marketCache.set(cacheKey, result, MARKET_TTL.fileContent);
      return result;
    },

    status: () => ({
      skillhub: getSourceHealth('skillhub'),
      clawhub: getSourceHealth('clawhub'),
    }),
  };
}
