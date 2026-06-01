import { randomUUID }        from 'node:crypto';
import type { SkillsRepo, SkillRow } from '@ema-agent/storage';
import { parseSkillMd, validateSkillMd } from './parser.js';
import type { SkillRecord, SkillActivateMode } from './types.js';

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" not found`);
    this.name = 'SkillNotFoundError';
  }
}

// ── SkillStore ────────────────────────────────────────────────────────────────
//
// Business-logic layer over SkillsRepo.
// Handles frontmatter parsing and CRUD in domain types.

export class SkillStore {
  constructor(private readonly repo: SkillsRepo) {}

  // ── Install / update ──────────────────────────────────────────────────────

  install(rawMd: string, sourceUrl?: string): SkillRecord {
    const manifest = parseSkillMd(rawMd); // throws on invalid frontmatter
    const existing = this.repo.findByName(manifest.name);

    if (existing) {
      this.repo.update(existing.id, {
        version:        manifest.version,
        description:    manifest.description,
        sourceUrl:      sourceUrl ?? null,
        contentMd:      rawMd,
        activatesJson:  JSON.stringify(manifest.activates),
      });
      return this.rowToRecord({ ...existing, content_md: rawMd, version: manifest.version,
        description: manifest.description, source_url: sourceUrl ?? null,
        activates_json: JSON.stringify(manifest.activates) });
    }

    const id = randomUUID();
    this.repo.insert({
      id,
      name:           manifest.name,
      version:        manifest.version,
      description:    manifest.description,
      source_url:     sourceUrl ?? null,
      content_md:     rawMd,
      activates_json: JSON.stringify(manifest.activates),
      enabled:        1,
      installed_at:   Date.now(),
    });
    return this.findByName(manifest.name)!;
  }

  validate(rawMd: string) {
    return validateSkillMd(rawMd);
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  setEnabled(name: string, enabled: boolean): void {
    const row = this.repo.findByName(name);
    if (!row) throw new SkillNotFoundError(name);
    this.repo.update(row.id, { enabled: enabled ? 1 : 0 });
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  remove(name: string): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    this.repo.deleteById(row.id);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  findByName(name: string): SkillRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.rowToRecord(row) : null;
  }

  listAll(): SkillRecord[] {
    return this.repo.listAll().map((r) => this.rowToRecord(r));
  }

  /** Returns skills that are enabled AND activate in the given mode. */
  listActiveForMode(mode: SkillActivateMode): SkillRecord[] {
    return this.repo.listEnabled()
      .map((r) => this.rowToRecord(r))
      .filter((s) => s.manifest.activates.includes(mode));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private rowToRecord(row: SkillRow): SkillRecord {
    return {
      id:          row.id,
      manifest:    parseSkillMd(row.content_md),
      sourceUrl:   row.source_url ?? undefined,
      enabled:     row.enabled === 1,
      installedAt: row.installed_at,
      rawMd:       row.content_md,
    };
  }
}
