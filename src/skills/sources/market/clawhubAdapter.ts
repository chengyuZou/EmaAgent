// ClawHub Adapter(https://clawhub.ai)
//   GET /api/v1/skills?limit=&cursor=&sort=downloads → {items, nextCursor}
//   GET /api/v1/search?q=                            → {results}(无分页)
//   GET /api/v1/skills/{slug}                        → {skill, latestVersion, owner}
//   GET /api/v1/skills/{slug}/versions/{v}           → {version:{license, files[], security}}
//   GET /api/v1/skills/{slug}/file?path=             → 文件原文
import {
  detectMarketLanguage,
  MARKET_ERROR_CODES,
  MARKET_LIMITS,
  MarketUpstreamError,
  marketSkillId,
  type AdapterFileEntry,
  type AdapterListPage,
  type MarketAdapter,
  type MarketSkill,
  type MarketSkillDetail,
} from './types.js';
import { MARKET_SOURCE_BASES, marketFetch, marketFetchJson, readResponseTextWithLimit } from './fetch.js';

type ClawhubListItem = {
  slug: string;
  displayName?: string;
  summary?: string;
  description?: string;
  topics?: string[];
  stats?: { downloads?: number };
  latestVersion?: { version?: string };
};

type ClawhubSearchResult = {
  slug: string;
  displayName?: string;
  summary?: string;
  downloads?: number;
};

type ClawhubDetail = {
  skill: ClawhubListItem;
  latestVersion?: { version?: string; license?: string };
};

type ClawhubVersionDetail = {
  version?: {
    version?: string;
    license?: string;
    files?: AdapterFileEntry[];
    security?: { status?: string; virustotalUrl?: string };
  };
};

// ClawHub 的 slug 跨作者不唯一:歧义 slug 返回 409 AMBIGUOUS_SKILL_SLUG 带候选作者,
// 用 ?owner= 消歧(取首个候选)并记住解析结果。
const ownerCache = new Map<string, string>();

async function clawhubFetch(url: URL): Promise<Response> {
  const slug = slugFromPath(url);
  const cachedOwner = slug ? ownerCache.get(slug) : undefined;
  if (cachedOwner && !url.searchParams.has('owner')) {
    url.searchParams.set('owner', cachedOwner);
  }
  const res = await marketFetch('clawhub', url.toString());
  if (res.status !== 409) return res;

  const body = (await res.json().catch(() => null)) as
    | { code?: string; matches?: Array<{ ownerHandle?: string }> }
    | null;
  const resolvedOwner = body?.code === 'AMBIGUOUS_SKILL_SLUG' ? body.matches?.[0]?.ownerHandle : undefined;
  if (!resolvedOwner || !slug) {
    throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamError, `clawhub 响应 409: ${url.pathname}`);
  }
  ownerCache.set(slug, resolvedOwner);
  url.searchParams.set('owner', resolvedOwner);
  return marketFetch('clawhub', url.toString());
}

function slugFromPath(url: URL): string | undefined {
  const match = /\/api\/v1\/skills\/([^/]+)/.exec(url.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function clawhubFetchJson<T>(url: URL): Promise<T> {
  const res = await clawhubFetch(url);
  if (!res.ok) {
    throw new MarketUpstreamError(
      'clawhub',
      res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
      `clawhub 响应 ${res.status}: ${url.pathname}`,
    );
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub 返回了非法 JSON');
  }
}

function normalizeListItem(item: ClawhubListItem): MarketSkill {
  return {
    id: marketSkillId('clawhub', item.slug),
    source: 'clawhub',
    slug: item.slug,
    name: item.displayName || item.slug,
    summary: item.summary || '',
    version: item.latestVersion?.version,
    downloads: item.stats?.downloads ?? 0,
    tags: Array.isArray(item.topics) ? item.topics.filter((t): t is string => typeof t === 'string') : [],
    installState: 'installable',
  };
}

function normalizeSearchResult(result: ClawhubSearchResult): MarketSkill {
  return {
    id: marketSkillId('clawhub', result.slug),
    source: 'clawhub',
    slug: result.slug,
    name: result.displayName || result.slug,
    summary: result.summary || '',
    downloads: result.downloads ?? 0,
    tags: [],
    installState: 'installable',
  };
}

export const clawhubAdapter: MarketAdapter = {
  source: 'clawhub',

  async list({ cursor, limit }): Promise<AdapterListPage> {
    const url = new URL('/api/v1/skills', MARKET_SOURCE_BASES.clawhub);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', 'downloads');
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await marketFetchJson<{ items?: ClawhubListItem[]; nextCursor?: string }>(
      'clawhub',
      url.toString(),
    );
    if (!Array.isArray(data.items)) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub 列表缺少 items');
    }
    return {
      items: data.items.filter((i) => i?.slug).map(normalizeListItem),
      ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
    };
  },

  async search({ q, limit }): Promise<AdapterListPage> {
    const url = new URL('/api/v1/search', MARKET_SOURCE_BASES.clawhub);
    url.searchParams.set('q', q);
    const data = await marketFetchJson<{ results?: ClawhubSearchResult[] }>('clawhub', url.toString());
    if (!Array.isArray(data.results)) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub 搜索缺少 results');
    }
    // ClawHub 搜索无分页——截断即穷尽。
    return { items: data.results.filter((r) => r?.slug).slice(0, limit).map(normalizeSearchResult) };
  },

  async detail(slug): Promise<MarketSkillDetail> {
    const data = await clawhubFetchJson<ClawhubDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, MARKET_SOURCE_BASES.clawhub),
    );
    if (!data.skill?.slug) {
      throw new MarketUpstreamError('clawhub', MARKET_ERROR_CODES.upstreamBadResponse, 'clawhub 详情缺少 skill');
    }

    const version = data.latestVersion?.version || data.skill.latestVersion?.version;
    let files: AdapterFileEntry[] = [];
    let license: string | undefined = data.latestVersion?.license;
    let securityNote: string | undefined;
    if (version) {
      try {
        const versionDetail = await clawhubFetchJson<ClawhubVersionDetail>(
          new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`, MARKET_SOURCE_BASES.clawhub),
        );
        files = versionDetail.version?.files ?? [];
        license = versionDetail.version?.license || license;
        const scan = versionDetail.version?.security?.status;
        if (scan) securityNote = `ClawHub 扫描：${scan}`;
      } catch {
        // 版本详情尽力而为;没有文件清单的详情仍然可读。
      }
    }

    // ClawHub 的 description 就是 SKILL.md 原文(含 frontmatter),剥掉头部只留正文。
    const raw = data.skill.description || '';
    const item = normalizeListItem(data.skill);
    return {
      ...item,
      version,
      description: stripFrontmatter(raw),
      ...(license ? { license } : {}),
      ...(securityNote ? { securityNote } : {}),
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        ...(f.sha256 ? { sha256: f.sha256 } : {}),
        language: detectMarketLanguage(f.path),
        tooBig: f.size > MARKET_LIMITS.maxFileSize,
      })),
      totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
    };
  },

  async listFiles(slug, version): Promise<AdapterFileEntry[]> {
    let resolvedVersion = version;
    if (!resolvedVersion) {
      const data = await clawhubFetchJson<ClawhubDetail>(
        new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, MARKET_SOURCE_BASES.clawhub),
      );
      resolvedVersion = data.latestVersion?.version || data.skill?.latestVersion?.version;
    }
    if (!resolvedVersion) return [];
    const versionDetail = await clawhubFetchJson<ClawhubVersionDetail>(
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(resolvedVersion)}`, MARKET_SOURCE_BASES.clawhub),
    );
    return versionDetail.version?.files ?? [];
  },

  async fetchFile(slug, filePath): Promise<{ content: string; size: number }> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, MARKET_SOURCE_BASES.clawhub);
    url.searchParams.set('path', filePath);
    const res = await clawhubFetch(url);
    if (!res.ok) {
      throw new MarketUpstreamError(
        'clawhub',
        res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
        `clawhub 取文件失败 (${res.status})`,
      );
    }
    return readResponseTextWithLimit('clawhub', res, MARKET_LIMITS.maxFileSize, `文件 ${filePath}`);
  },
};

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).trim();
}
