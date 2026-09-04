// SkillHub Adapter(https://api.skillhub.cn)
//   GET /api/skills?page=&pageSize=&keyword=   → {code, data:{skills[], total}, message}
//     分页参数必须是 pageSize(limit 被静默忽略);搜索参数必须是 keyword(q 被静默忽略)
//   GET /api/v1/skills/{slug}                  → {skill, owner, latestVersion, securityReports}
//   GET /api/v1/skills/{slug}/files            → {count, files:[{path, sha256, size}]}
//   GET /api/v1/skills/{slug}/file?path=       → 302 跳腾讯 COS(fetch 跟随)
import {
  detectMarketLanguage,
  MARKET_ERROR_CODES,
  MarketUpstreamError,
  marketSkillId,
  type AdapterFileEntry,
  type AdapterListPage,
  type MarketAdapter,
  type MarketSkill,
  type MarketSkillDetail,
} from './types.js';
import { MARKET_SOURCE_BASES, marketFetch, marketFetchJson, readResponseTextWithLimit } from './fetch.js';
import { MARKET_LIMITS } from './types.js';

type SkillhubListItem = {
  slug: string;
  name?: string;
  displayName?: string;
  summary?: string;
  summary_zh?: string;
  description?: string;
  description_zh?: string;
  subCategories?: Array<{ key?: string; name?: string }>;
  downloads?: number;
  version?: string;
  iconUrl?: string;
  labels?: Record<string, string>;
  verified?: boolean;
  source?: string;
  upstream_url?: string;
};

type SkillhubEnvelope<T> = { code: number; data: T; message?: string };

type SkillhubDetail = {
  skill?: SkillhubListItem & { stats?: { downloads?: number } };
  owner?: { handle?: string; displayName?: string };
  latestVersion?: { version?: string };
  securityReports?: Record<string, { status?: string } | undefined>;
};

function normalizeListItem(item: SkillhubListItem): MarketSkill {
  const tags: string[] = [];
  for (const sub of item.subCategories ?? []) {
    if (sub?.name) tags.push(sub.name);
  }
  return {
    id: marketSkillId('skillhub', item.slug),
    source: 'skillhub',
    slug: item.slug,
    name: item.name || item.displayName || item.slug,
    summary: item.description_zh || item.description || item.summary_zh || item.summary || '',
    version: item.version,
    downloads: item.downloads ?? 0,
    tags,
    ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
    ...(item.verified ? { securityNote: 'SkillHub：发布者已认证' } : {}),
    ...upstreamOf(item),
    installState: 'installable',
  };
}

/** SkillHub 部分条目镜像 ClawHub(source='clawhub' + upstream_url 末段是原始 slug)。 */
function upstreamOf(item: SkillhubListItem): Pick<MarketSkill, 'upstream'> {
  if (item.source !== 'clawhub' || !item.upstream_url) return {};
  try {
    const segments = new URL(item.upstream_url).pathname.split('/').filter(Boolean);
    const slug = segments[segments.length - 1];
    if (slug) return { upstream: { source: 'clawhub', slug } };
  } catch {
    // 上游 URL 畸形就当原生条目。
  }
  return {};
}

async function fetchPage(params: { keyword?: string; page: number; pageSize: number }): Promise<AdapterListPage> {
  const url = new URL('/api/skills', MARKET_SOURCE_BASES.skillhub);
  url.searchParams.set('page', String(params.page));
  url.searchParams.set('pageSize', String(params.pageSize));
  if (params.keyword) url.searchParams.set('keyword', params.keyword);

  const envelope = await marketFetchJson<SkillhubEnvelope<{ skills?: SkillhubListItem[]; total?: number }>>(
    'skillhub',
    url.toString(),
  );
  if (envelope.code !== 0 || !Array.isArray(envelope.data?.skills)) {
    throw new MarketUpstreamError(
      'skillhub',
      MARKET_ERROR_CODES.upstreamBadResponse,
      `skillhub 响应 code=${envelope.code}: ${envelope.message || '非法负载'}`,
    );
  }
  const items = envelope.data.skills.filter((s) => s?.slug).map(normalizeListItem);
  const total = envelope.data.total ?? 0;
  const hasMore = params.page * params.pageSize < total;
  return { items, ...(hasMore ? { nextCursor: String(params.page + 1) } : {}), total };
}

export const skillhubAdapter: MarketAdapter = {
  source: 'skillhub',

  list({ cursor, limit }): Promise<AdapterListPage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
    return fetchPage({ page, pageSize: limit });
  },

  search({ q, cursor, limit }): Promise<AdapterListPage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
    return fetchPage({ keyword: q, page, pageSize: limit });
  },

  async detail(slug): Promise<MarketSkillDetail> {
    const data = await marketFetchJson<SkillhubDetail>(
      'skillhub',
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, MARKET_SOURCE_BASES.skillhub).toString(),
    );
    if (!data.skill?.slug) {
      throw new MarketUpstreamError('skillhub', MARKET_ERROR_CODES.upstreamBadResponse, 'skillhub 详情缺少 skill');
    }

    const item = normalizeListItem(data.skill);
    const downloads = data.skill.stats?.downloads ?? item.downloads;
    const version = data.latestVersion?.version || item.version;

    let files: AdapterFileEntry[] = [];
    try {
      files = await skillhubAdapter.listFiles(slug);
    } catch {
      // 详情页的文件清单尽力而为;安装时会重新拉取。
    }

    // SkillHub 详情没有 SKILL.md 全文——单独拉一份给文档标签。
    let description = '';
    if (files.some((f) => f.path === 'SKILL.md')) {
      try {
        description = (await skillhubAdapter.fetchFile(slug, 'SKILL.md')).content;
      } catch {
        description = item.summary;
      }
    } else {
      description = item.summary;
    }

    return {
      ...item,
      downloads,
      version,
      description,
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

  async listFiles(slug): Promise<AdapterFileEntry[]> {
    const data = await marketFetchJson<{ count?: number; files?: AdapterFileEntry[] }>(
      'skillhub',
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/files`, MARKET_SOURCE_BASES.skillhub).toString(),
    );
    if (!Array.isArray(data.files)) {
      throw new MarketUpstreamError('skillhub', MARKET_ERROR_CODES.upstreamBadResponse, 'skillhub 文件清单缺失');
    }
    return data.files;
  },

  async fetchFile(slug, filePath): Promise<{ content: string; size: number }> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, MARKET_SOURCE_BASES.skillhub);
    url.searchParams.set('path', filePath);
    const res = await marketFetch('skillhub', url.toString());
    if (!res.ok) {
      throw new MarketUpstreamError(
        'skillhub',
        res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
        `skillhub 取文件失败 (${res.status})`,
      );
    }
    return readResponseTextWithLimit('skillhub', res, MARKET_LIMITS.maxFileSize, `文件 ${filePath}`);
  },
};
