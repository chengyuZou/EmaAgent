import { createHash } from 'node:crypto';
import type { SkillStore } from './store.js';
import type { SkillRecord } from './types.js';

// ── SkillInstaller ────────────────────────────────────────────────────────────
//
// Acquires SKILL.md content from different sources and delegates to SkillStore,
// which writes it into the user root as `<slug>/SKILL.md` (atomic) and indexes.

const MAX_SKILL_BYTES = 512 * 1024; // a SKILL.md is prose; cap to defend against abuse

export class SkillInstaller {
  constructor(private readonly store: SkillStore) {}

  /** Install from raw SKILL.md text (local paste or file read). */
  async installFromText(rawMd: string): Promise<SkillRecord> {
    assertSize(rawMd);
    return this.store.install(rawMd);
  }

  /**
   * Download a single SKILL.md from a URL and install it.
   * `expectedSha256` (from a market manifest) is verified when provided.
   */
  async installFromUrl(url: string, expectedSha256?: string): Promise<SkillRecord> {
    const rawMd = await downloadText(url);
    const sha256 = createHash('sha256').update(rawMd).digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(`Skill integrity check failed for ${url}: sha256 mismatch`);
    }
    return this.store.install(rawMd, { sourceUrl: url, sha256 });
  }

  /** Validate without installing — used by the UI preview step. */
  validate(rawMd: string) {
    return this.store.validate(rawMd);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function downloadText(url: string): Promise<string> {
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

function assertSize(rawMd: string): void {
  const bytes = Buffer.byteLength(rawMd, 'utf8');
  if (bytes > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md too large (${bytes} bytes > ${MAX_SKILL_BYTES})`);
  }
}
