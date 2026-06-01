import type { SkillStore } from './store.js';
import type { SkillRecord } from './types.js';

// ── SkillInstaller ────────────────────────────────────────────────────────────
//
// Handles acquiring SKILL.md content from different sources and
// delegating to SkillStore for persistence.

export class SkillInstaller {
  constructor(private readonly store: SkillStore) {}

  /** Install a skill from raw SKILL.md markdown string (local paste or file read). */
  installFromText(rawMd: string): SkillRecord {
    return this.store.install(rawMd);
  }

  /** Download a SKILL.md from a URL and install it. */
  async installFromUrl(url: string): Promise<SkillRecord> {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/markdown, text/plain, */*' },
      signal:  AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Failed to download skill from ${url}: HTTP ${res.status}`);
    }

    const rawMd = await res.text();
    return this.store.install(rawMd, url);
  }

  /** Validate without installing — used by the UI preview step. */
  validate(rawMd: string) {
    return this.store.validate(rawMd);
  }
}
