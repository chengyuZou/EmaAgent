import { z } from 'zod';

/** 技能市场来源;V1 固定两个真实市场,用户不能加源。 */
export type MarketSource = 'skillhub' | 'clawhub';

export const MARKET_SOURCES: readonly MarketSource[] = ['skillhub', 'clawhub'];

export type InstallState = 'installed' | 'installable' | 'not-installable';

export type NotInstallableReason =
  | 'empty-file-list'
  | 'file-too-large'
  | 'too-many-files'
  | 'invalid-name'
  | 'name-conflict';

/** 市场卡片/列表的归一化条目:Ema 真正消费的字段,不是任一上游的原始形状。 */
export interface MarketSkill {
  /** `${source}:${slug}` 全局唯一。 */
  readonly id: string;
  readonly source: MarketSource;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly version?: string;
  readonly downloads: number;
  readonly tags: readonly string[];
  /** 卡片图标(SkillHub 提供);无则前端画首字母块。 */
  readonly iconUrl?: string;
  /** 来源方安全事实的原文透传(如"SkillHub: 发布者已认证"),不做跨源归一化。 */
  readonly securityNote?: string;
  /** SkillHub 镜像 ClawHub 条目时指向原始条目(去重合并用)。 */
  readonly upstream?: { readonly source: MarketSource; readonly slug: string };
  /** 去重后被合并进本条的他源镜像 id。 */
  readonly mirrors?: readonly string[];
  readonly installState: InstallState;
  readonly notInstallableReason?: NotInstallableReason;
  readonly installedInfo?: { readonly version?: string; readonly installedAt: string; readonly dirName: string };
}

export interface MarketFileMeta {
  readonly path: string;
  readonly size: number;
  readonly sha256?: string;
  readonly language: string;
  /** 超过单文件安装/预览上限。 */
  readonly tooBig: boolean;
}

export interface MarketSkillDetail extends MarketSkill {
  /** SKILL.md 正文(剥 frontmatter);拿不到时回退为摘要。 */
  readonly description: string;
  readonly license?: string;
  readonly files: readonly MarketFileMeta[];
  readonly totalSize: number;
}

export interface MarketFileContent {
  readonly path: string;
  readonly content: string;
  readonly language: string;
  readonly size: number;
  readonly truncated: boolean;
}

export type SourceHealthStatus = 'ok' | 'degraded' | 'failed' | 'cached';

export interface SourceStatusInfo {
  readonly status: SourceHealthStatus;
  readonly fetchedAt?: number;
  readonly fromCache?: boolean;
  readonly error?: string;
}

export interface MarketListResult {
  readonly items: MarketSkill[];
  readonly nextCursor: string | null;
  readonly sources: Record<MarketSource, SourceStatusInfo>;
}

// ── Adapter 层 ────────────────────────────────────────────────────────────────

export interface AdapterListPage {
  readonly items: MarketSkill[];
  /** 上游原生游标;undefined =  exhausted。 */
  readonly nextCursor?: string;
  readonly total?: number;
}

export interface AdapterFileEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256?: string;
}

/** 每个市场一个 Adapter:直接理解该市场的真实 API,投影成 Ema 统一条目。 */
export interface MarketAdapter {
  readonly source: MarketSource;
  list(params: { cursor?: string; limit: number }): Promise<AdapterListPage>;
  search(params: { q: string; cursor?: string; limit: number }): Promise<AdapterListPage>;
  detail(slug: string): Promise<MarketSkillDetail>;
  listFiles(slug: string, version?: string): Promise<AdapterFileEntry[]>;
  fetchFile(slug: string, filePath: string): Promise<{ content: string; size: number }>;
}

// ── 错误与上限 ────────────────────────────────────────────────────────────────

export const MARKET_ERROR_CODES = {
  upstreamError: 'market_upstream_error',
  upstreamTimeout: 'market_upstream_timeout',
  upstreamBadResponse: 'market_upstream_bad_response',
  installInProgress: 'market_install_in_progress',
  alreadyInstalled: 'market_already_installed',
  notInstallable: 'market_not_installable',
  checksumMismatch: 'market_checksum_mismatch',
  notInstalled: 'market_not_installed',
  notManaged: 'market_not_managed',
} as const;

/** 上游错误必须保留来源与真实错误语义。 */
export class MarketUpstreamError extends Error {
  constructor(
    public readonly source: MarketSource,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MarketUpstreamError';
  }
}

export const MARKET_LIMITS = {
  maxFileSize: 5 * 1024 * 1024,
  maxTotalSize: 20 * 1024 * 1024,
  maxFileCount: 200,
  previewTruncateBytes: 300 * 1024,
  /** ClawHub 搜索无分页,合并搜索结果的硬上限。 */
  searchResultCap: 50,
} as const;

export function marketSkillId(source: MarketSource, slug: string): string {
  return `${source}:${slug}`;
}

export function parseMarketSkillId(id: string): { source: MarketSource; slug: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  const source = id.slice(0, idx);
  const slug = id.slice(idx + 1);
  if (!(MARKET_SOURCES as readonly string[]).includes(source) || !slug) return null;
  return { source: source as MarketSource, slug };
}

/** 目录名白名单:小写字母数字 + 短横/下划线/点(不开头的点),拒绝连续点。 */
export function sanitizeDirName(slug: string): string | null {
  const name = slug.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

const LANG_MAP: Record<string, string> = {
  md: 'markdown', ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', toml: 'toml', css: 'css', html: 'html',
  txt: 'text', xml: 'xml', sql: 'sql', rs: 'rust', go: 'go', rb: 'ruby',
};

/** 文件预览的语法高亮语言(按扩展名)。 */
export function detectMarketLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return LANG_MAP[ext] || 'text';
}

/** 市场安装溯源标记:随技能目录走,卸载验明正身用。 */
export const MARKET_META_FILENAME = '.ema-market.json';

export interface MarketMeta {
  readonly id: string;
  readonly source: MarketSource;
  readonly slug: string;
  readonly version?: string;
  readonly installedAt: string;
  readonly fileCount: number;
}

const metaSchema = z.object({
  id: z.string().min(1),
  source: z.enum(MARKET_SOURCES as [MarketSource, MarketSource]),
  slug: z.string().min(1),
  version: z.string().optional(),
  installedAt: z.string().min(1),
  fileCount: z.number().int().min(0),
}).strip();

export function parseMarketMeta(value: unknown): MarketMeta | null {
  const parsed = metaSchema.safeParse(value);
  if (!parsed.success) return null;
  const meta = parsed.data;
  if (meta.id !== marketSkillId(meta.source, meta.slug)) return null;
  if (!sanitizeDirName(meta.slug)) return null;
  return meta;
}
