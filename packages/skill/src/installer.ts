import { createHash } from 'node:crypto';
import type { SkillStore } from './store.js';
import type { SkillRecord } from './types.js';

// ── SkillInstaller ────────────────────────────────────────────────────────────
//
// Acquires SKILL.md content from different sources and delegates to SkillStore,
// which writes it into the user root as `<slug>/SKILL.md` (atomic) and indexes.

const MAX_SKILL_BYTES   = 512 * 1024;      // a SKILL.md is prose; cap to defend against abuse
const MAX_BUNDLE_BYTES  = 8 * 1024 * 1024; // whole skill folder (SKILL.md + scripts/ + refs)
const MAX_BUNDLE_FILES  = 80;

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
   */
  async installFromUrl(url: string, expectedSha256?: string): Promise<SkillRecord> {
    const bundle = await tryFetchGithubBundle(url);

    const rawMd  = bundle ? bundle.skillMd : await downloadText(url);
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/** raw.githubusercontent.com → jsDelivr CDN, which is reachable where GitHub is blocked/slow. */
function githubRawToJsdelivr(url: string): string | null {
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`;
}

async function fetchSkillText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/markdown, text/plain, */*' },
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Failed to download skill from ${url}: HTTP ${res.status}`);

  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_SKILL_BYTES) {
    throw new Error(`Skill at ${url} is too large (${len} bytes > ${MAX_SKILL_BYTES})`);
  }
  const rawMd = await res.text();
  assertSize(rawMd);
  return rawMd;
}

async function downloadText(url: string): Promise<string> {
  try {
    return await fetchSkillText(url);
  } catch (err) {
    // GitHub raw is frequently blocked/slow in CN — retry via the jsDelivr mirror.
    const mirror = githubRawToJsdelivr(url);
    if (mirror) {
      try { return await fetchSkillText(mirror); } catch { /* fall through to original error */ }
    }
    throw err;
  }
}

function assertSize(rawMd: string): void {
  const bytes = Buffer.byteLength(rawMd, 'utf8');
  if (bytes > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md too large (${bytes} bytes > ${MAX_SKILL_BYTES})`);
  }
}

// ── GitHub bundle download (SKILL.md + sibling files) ───────────────────────────

interface SkillBundle {
  skillMd: string;
  /** Sibling files keyed by path relative to the skill dir (excludes SKILL.md). */
  assets:  Record<string, Uint8Array>;
}

/** Parse a raw GitHub `…/SKILL.md` URL into its repo coordinates + skill dir. */
function parseGithubRawSkillUrl(url: string): { owner: string; repo: string; ref: string; dir: string } | null {
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (!m) return null;
  const [, owner, repo, ref, dirWithSlash] = m;
  return { owner: owner!, repo: repo!, ref: ref!, dir: (dirWithSlash ?? '').replace(/\/$/, '') };
}

/** If the URL is a GitHub-raw SKILL.md, download the whole skill folder. */
async function tryFetchGithubBundle(url: string): Promise<SkillBundle | null> {
  const coords = parseGithubRawSkillUrl(url);
  if (!coords) return null;
  const { owner, repo, ref, dir } = coords;

  let tree: Array<{ path: string; type: string; size?: number }>;
  try {
    const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
    const res = await fetch(api, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ema-agent' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;  // fall back to single-file
    tree = ((await res.json()) as { tree?: typeof tree }).tree ?? [];
  } catch {
    return null;
  }

  const prefix   = dir ? `${dir}/` : '';
  const skillPath = `${prefix}SKILL.md`;
  const blobs = tree.filter(
    (n) => n.type === 'blob' && n.path.startsWith(prefix) && n.path !== skillPath,
  );

  const skillMd = await downloadText(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`);
  if (blobs.length === 0) return { skillMd, assets: {} };
  if (blobs.length > MAX_BUNDLE_FILES) {
    throw new Error(`Skill bundle has too many files (${blobs.length} > ${MAX_BUNDLE_FILES}).`);
  }

  const assets: Record<string, Uint8Array> = {};
  let total = Buffer.byteLength(skillMd, 'utf8');
  for (const blob of blobs) {
    const rel = blob.path.slice(prefix.length);
    // Path-traversal guard: assets must stay inside the skill dir.
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`Skill bundle contains an unsafe path: ${rel}`);
    }
    const bytes = await downloadBytes(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${blob.path}`);
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      throw new Error(`Skill bundle too large (> ${MAX_BUNDLE_BYTES} bytes).`);
    }
    assets[rel] = bytes;
  }
  return { skillMd, assets };
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const fetchOnce = async (u: string): Promise<Uint8Array> => {
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to download ${u}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  try {
    return await fetchOnce(url);
  } catch (err) {
    const mirror = githubRawToJsdelivr(url);
    if (mirror) {
      try { return await fetchOnce(mirror); } catch { /* fall through */ }
    }
    throw err;
  }
}
