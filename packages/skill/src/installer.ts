import { createHash } from 'node:crypto';
import type { SkillStore } from './store.js';
import type { SkillRecord } from './types.js';
import {
  fetchGithubTree,
  fetchText,
  fetchWithMirror,
  githubRawToJsdelivr,
  type GitTreeNode,
} from '@ema-agent/marketplace';

// ── SkillInstaller ────────────────────────────────────────────────────────────
//
// 从不同来源获取 SKILL.md 内容,委托 SkillStore 写入 user root(<slug>/SKILL.md,
// 原子写)+ 索引。GitHub-raw URL 会下载整个 skill 目录(SKILL.md + scripts/ + refs/),
// 让带可运行脚本的 skill 也能工作 —— 不只是 markdown。
//
// URL 拼接 / fetch / 镜像降级统一走 @ema-agent/marketplace 底座,不在本包重复实现。

const MAX_SKILL_BYTES   = 512 * 1024;      // a SKILL.md is prose; cap to defend against abuse
const MAX_BUNDLE_BYTES  = 8 * 1024 * 1024; // whole skill folder (SKILL.md + scripts/ + refs)
const MAX_BUNDLE_FILES  = 80;
const FETCH_TIMEOUT_MS  = 30_000;          // skill 文件下载允许比默认 15s 更久

export class SkillInstaller {
  constructor(private readonly store: SkillStore) {}

  /** Install from raw SKILL.md text (local paste or file read). */
  async installFromText(rawMd: string): Promise<SkillRecord> {
    assertSize(rawMd);
    return this.store.install(rawMd);
  }

  /**
   * Install a skill from a URL. When the URL is a GitHub-raw `SKILL.md`, the
   * WHOLE skill folder (scripts/, references/, assets) is downloaded so skills
   * that ship runnable scripts work — not just the markdown. Other URLs fall
   * back to a single-file install.
   * `expectedSha256` (from a market manifest) is verified against SKILL.md.
   * `signal` 透传给所有 fetch,调用方可中止安装。
   */
  async installFromUrl(
    url: string,
    expectedSha256?: string,
    signal?: AbortSignal,
  ): Promise<SkillRecord> {
    const bundle = await tryFetchGithubBundle(url, signal);

    const rawMd  = bundle ? bundle.skillMd : await downloadSkillText(url, signal);
    const sha256 = createHash('sha256').update(rawMd).digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(`Skill integrity check failed for ${url}: sha256 mismatch`);
    }
    return this.store.install(rawMd, { sourceUrl: url, sha256, assets: bundle?.assets });
  }

  /** Validate without installing — used by the UI preview step. */
  validate(rawMd: string) {
    return this.store.validate(rawMd);
  }
}

// ── SKILL.md 文本下载(带 size 校验 + jsDelivr 镜像降级)─────────────────────────

async function downloadSkillText(url: string, signal?: AbortSignal): Promise<string> {
  // fetchText 内部已处理 raw → jsDelivr 降级(mirrorUrl 用 githubRawToJsdelivr 推导)
  const mirror = githubRawToJsdelivr(url) ?? undefined;
  const rawMd = await fetchText(url, mirror, { timeoutMs: FETCH_TIMEOUT_MS, signal });
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
  /** Sibling files keyed by path relative to the skill dir (excludes SKILL.md). */
  assets:  Record<string, Uint8Array>;
}

/** 解析 GitHub-raw `…/SKILL.md` URL 为 repo 坐标 + skill 目录。 */
function parseGithubRawSkillUrl(url: string): { owner: string; repo: string; ref: string; dir: string } | null {
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (!m) return null;
  const [, owner, repo, ref, dirWithSlash] = m;
  return { owner: owner!, repo: repo!, ref: ref!, dir: (dirWithSlash ?? '').replace(/\/$/, '') };
}

/** 若 URL 是 GitHub-raw SKILL.md,下载整个 skill 目录(SKILL.md + siblings)。否则返回 null(走单文件)。 */
async function tryFetchGithubBundle(url: string, signal?: AbortSignal): Promise<SkillBundle | null> {
  const coords = parseGithubRawSkillUrl(url);
  if (!coords) return null;
  const { owner, repo, ref, dir } = coords;

  // api.github.com 不被 CDN 代理,失败就降级单文件下载
  let tree: GitTreeNode[];
  try {
    tree = await fetchGithubTree(owner, repo, ref, { signal });
  } catch {
    return null;
  }

  const prefix    = dir ? `${dir}/` : '';
  const skillPath = `${prefix}SKILL.md`;
  const blobs = tree.filter(
    (n) => n.type === 'blob' && n.path.startsWith(prefix) && n.path !== skillPath,
  );

  const skillMd = await downloadSkillText(
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`,
    signal,
  );
  if (blobs.length === 0) return { skillMd, assets: {} };
  if (blobs.length > MAX_BUNDLE_FILES) {
    throw new Error(`Skill bundle has too many files (${blobs.length} > ${MAX_BUNDLE_FILES}).`);
  }

  const assets: Record<string, Uint8Array> = {};
  let total = Buffer.byteLength(skillMd, 'utf8');
  for (const blob of blobs) {
    const rel = blob.path.slice(prefix.length);
    // 路径穿越防护:asset 必须留在 skill 目录内
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`Skill bundle contains an unsafe path: ${rel}`);
    }
    const bytes = await downloadAssetBytes(
      `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${blob.path}`,
      signal,
    );
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      throw new Error(`Skill bundle too large (> ${MAX_BUNDLE_BYTES} bytes).`);
    }
    assets[rel] = bytes;
  }
  return { skillMd, assets };
}

/** 下载二进制 asset(带 jsDelivr 镜像降级,size 由调用方累加校验)。 */
async function downloadAssetBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const mirror = githubRawToJsdelivr(url) ?? undefined;
  const res = await fetchWithMirror(url, mirror, { timeoutMs: FETCH_TIMEOUT_MS, signal });
  return new Uint8Array(await res.arrayBuffer());
}
