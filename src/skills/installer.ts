// 这里从文本或受信公网来源下载 Skill, 校验完整性并交给 SkillStore 安装.
import type { SkillStore } from './store.js';
import type { GithubSkillCoords, SkillRecord } from './types.js';
import {
  fetchGithubTree,
  fetchText,
  fetchWithMirror,
  githubRawToJsdelivr,
  type GitTreeNode,
} from '@ema-agent/marketplace';
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BYTES,
} from './limits.js';

// ── SkillInstaller ────────────────────────────────────────────────────────────
//
// 从不同来源获取 SKILL.md 内容,委托 SkillStore 写入 user root(<slug>/SKILL.md,
// 原子写)+ 索引。GitHub-raw URL 会下载整个 skill 目录(SKILL.md + scripts/ + refs/),
// 让带可运行脚本的 skill 也能工作 -- 不只是 markdown。
//
// URL 拼接 / fetch / 镜像降级统一走 @ema-agent/marketplace 底座,不在本包重复实现。

const FETCH_TIMEOUT_MS  = 30_000;          // skill 文件下载允许比默认 15s 更久

export class SkillInstaller {
  constructor(private readonly store: SkillStore) {}

  /** 从原始 SKILL.md 文本安装(本地粘贴或文件读)。 */
  async installFromText(rawMd: string): Promise<SkillRecord> {
    assertSize(rawMd);
    return this.store.install(rawMd);
  }

  /**
   * 从 URL 安装 skill。URL 是 GitHub-raw `SKILL.md` 时,下载整个 skill 目录
   * (scripts/、references/、assets),让带可运行脚本的 skill 也能工作 - 不只 markdown。
   * 其他 URL 回退单文件安装。
   * `expectedSha256` 来自市场清单，覆盖 SKILL.md 与全部资源文件。
   * `signal` 透传给所有 fetch,调用方可中止安装。
   * `coords`   market entry 携带的 GitHub 坐标,优先于 URL 反解析 --
   *            jsDelivr URL 也能正确触发 bundle 下载(不丢 sibling assets)。
   */
  async installFromUrl(
    url: string,
    expectedSha256?: string,
    signal?: AbortSignal,
    coords?: GithubSkillCoords,
  ): Promise<SkillRecord> {
    const bundle = await tryFetchGithubBundle(url, signal, coords);

    const rawMd  = bundle
      ? bundle.skillMd
      : await downloadSkillText(url, githubRawToJsdelivr(url) ?? undefined, signal);
    return this.store.install(rawMd, {
      sourceUrl: url,
      expectedBundleSha256: expectedSha256,
      assets: bundle?.assets,
    });
  }

  /** 只校验不安装 - UI 预览步骤用。 */
  validate(rawMd: string) {
    return this.store.validate(rawMd);
  }
}

// ── SKILL.md 文本下载(带 size 校验 + 镜像降级)─────────────────────────────────

async function downloadSkillText(
  url:    string,
  mirror: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const rawMd = await fetchText(url, mirror, {
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
    maxBytes: MAX_SKILL_BYTES,
  });
  assertSize(rawMd);
  return rawMd;
}

function assertSize(rawMd: string): void {
  const bytes = Buffer.byteLength(rawMd, 'utf8');
  if (bytes > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md too large (${bytes} bytes > ${MAX_SKILL_BYTES})`);
  }
}

// ── GitHub bundle 下载(SKILL.md + 同目录 sibling 文件)──────────────────────────

interface SkillBundle {
  skillMd: string;
  /** sibling 文件,按相对 skill 目录的路径索引(不含 SKILL.md)。 */
  assets:  Record<string, Uint8Array>;
}

/**
 * 从 GitHub 坐标拼单个文件的 {主 URL, 降级 mirror}。
 * mirrorUrl 已知:主走 mirror(CN 可达 jsDelivr 等),降级 raw。
 * mirrorUrl 未知:主走 raw,降级 githubRawToJsdelivr 推导的 jsDelivr。
 */
function githubFileUrls(
  coords:   GithubSkillCoords,
  filePath: string,
): { url: string; mirror: string | undefined } {
  const raw = `https://raw.githubusercontent.com/${coords.owner}/${coords.repo}/${coords.ref}/${filePath}`;
  if (coords.mirrorUrl) {
    return { url: `${coords.mirrorUrl.replace(/\/$/, '')}/${filePath}`, mirror: raw };
  }
  return { url: raw, mirror: githubRawToJsdelivr(raw) ?? undefined };
}

/**
 * 解析 GitHub SKILL.md URL 为坐标 + mirrorUrl。支持两种 host:
 *  - raw.githubusercontent.com/owner/repo/ref/(dir/)SKILL.md
 *  - cdn.jsdelivr.net/gh/owner/repo@ref/(dir/)SKILL.md  (jsDelivr,反推时填 mirrorUrl)
 * 用户手动粘 URL 安装(无 coords)时走这里。
 */
function parseGithubSkillUrl(url: string): GithubSkillCoords | null {
  let m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (m) {
    const [, owner, repo, ref, dirWithSlash] = m;
    return { owner: owner!, repo: repo!, ref: ref!, dir: (dirWithSlash ?? '').replace(/\/$/, '') };
  }
  m = url.match(/^https?:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/]+)@([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (m) {
    const [, owner, repo, ref, dirWithSlash] = m;
    return {
      owner:     owner!,
      repo:      repo!,
      ref:       ref!,
      dir:       (dirWithSlash ?? '').replace(/\/$/, ''),
      mirrorUrl: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/`,
    };
  }
  return null;
}

/**
 * 若 URL/coords 指向 GitHub SKILL.md,下载整个 skill 目录(SKILL.md + siblings)。
 * 优先用 market entry 透传的 coords;无 coords 则 URL 反解析(支持 raw + jsDelivr)。
 * 返回 null 表示非 GitHub SKILL.md(走单文件下载)。
 */
async function tryFetchGithubBundle(
  url:    string,
  signal: AbortSignal | undefined,
  coords?: GithubSkillCoords,
): Promise<SkillBundle | null> {
  const c = coords ?? parseGithubSkillUrl(url);
  if (!c) return null;
  const { owner, repo, ref, dir } = c;

  // 已确认是 GitHub Bundle 时必须完整取得 tree. 静默降级单文件会制造表面成功的残缺 Skill.
  const tree: GitTreeNode[] = await fetchGithubTree(owner, repo, ref, { signal });

  const prefix    = dir ? `${dir}/` : '';
  const skillPath = `${prefix}SKILL.md`;
  const blobs = tree.filter(
    (n) => n.type === 'blob' && n.path.startsWith(prefix) && n.path !== skillPath,
  );

  const skillMdUrls = githubFileUrls(c, skillPath);
  const skillMd = await downloadSkillText(skillMdUrls.url, skillMdUrls.mirror, signal);
  if (blobs.length === 0) return { skillMd, assets: {} };
  if (blobs.length > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(`Skill Bundle has too many files (${blobs.length} > ${MAX_SKILL_BUNDLE_FILES})`);
  }

  const assets: Record<string, Uint8Array> = {};
  let total = Buffer.byteLength(skillMd, 'utf8');
  for (const blob of blobs) {
    const rel = blob.path.slice(prefix.length);
    // 路径穿越防护:asset 必须留在 skill 目录内
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`Skill bundle contains an unsafe path: ${rel}`);
    }
    const remainingBytes = MAX_SKILL_BUNDLE_BYTES - total;
    if (remainingBytes <= 0 || (blob.size !== undefined && blob.size > remainingBytes)) {
      throw new Error(`Skill Bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} byte limit`);
    }
    const assetUrls = githubFileUrls(c, blob.path);
    const bytes = await downloadAssetBytes(assetUrls.url, assetUrls.mirror, signal, remainingBytes);
    total += bytes.byteLength;
    if (total > MAX_SKILL_BUNDLE_BYTES) {
      throw new Error(`Skill Bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} byte limit`);
    }
    assets[rel] = bytes;
  }
  return { skillMd, assets };
}

/** 下载二进制 asset(带镜像降级,size 由调用方累加校验)。 */
async function downloadAssetBytes(
  url:    string,
  mirror: string | undefined,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  const response = await fetchWithMirror(url, mirror, {
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
    maxBytes,
  });
  return response.bytes;
}
