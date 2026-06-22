import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { SkillsRepo, SkillRow } from '@ema-agent/storage';
import { parseSkillMd, validateSkillMd } from './parser.js';
import type {
  SkillActivateMode, SkillRecord, SkillRoot, SkillSource, SkillSummary,
} from './types.js';

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" not found`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillReadonlyError extends Error {
  constructor(name: string) {
    super(`Skill "${name}" lives in a read-only (builtin) root and cannot be modified`);
    this.name = 'SkillReadonlyError';
  }
}

const SKILL_FILE = 'SKILL.md';

// ── SkillStore ────────────────────────────────────────────────────────────────
//
// File-backed Skill store. The source of truth is `<root>/<slug>/SKILL.md` on
// disk; the SQL index (SkillsRepo) is a cache that lets the catalog be built
// without opening every file. The body is read lazily on activation (renderBody).
//
// Roots are scanned in order; later roots override same-named skills, so build
// roots in [builtin, user] order to make user customization win.

export class SkillStore {
  constructor(
    private readonly repo:  SkillsRepo,
    private readonly roots: readonly SkillRoot[],
  ) {}

  private get userRoot(): SkillRoot {
    const root = this.roots.find((r) => !r.readonly);
    if (!root) throw new Error('SkillStore: no writable (user) root configured');
    return root;
  }

  // ── Reconcile (startup + after external edits) ─────────────────────────────
  //
  // Scan every root, upsert valid skills into the index, prune rows whose
  // directory no longer exists. Returns { indexed, pruned, errors }.

  async scanAndReconcile(): Promise<{ indexed: number; pruned: number; errors: string[] }> {
    const errors: string[] = [];
    const seenNames = new Set<string>();
    let indexed = 0;

    for (const root of this.roots) {
      const entries = await this.#listSkillDirs(root.path);
      for (const dirPath of entries) {
        try {
          const record = await this.#indexOne(dirPath, root.source);
          seenNames.add(record.name);
          indexed++;
        } catch (err) {
          errors.push(`${dirPath}: ${(err as Error).message}`);
        }
      }
    }

    // Prune index rows whose on-disk skill is gone (file deleted out-of-band).
    let pruned = 0;
    for (const row of this.repo.listAll()) {
      if (!seenNames.has(row.name)) {
        this.repo.deleteByName(row.name);
        pruned++;
      }
    }
    return { indexed, pruned, errors };
  }

  async #listSkillDirs(rootPath: string): Promise<string[]> {
    let dirents;
    try {
      dirents = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return []; // root missing → no skills from it
    }
    const dirs: string[] = [];
    for (const d of dirents) {
      if (d.isDirectory() || d.isSymbolicLink()) dirs.push(join(rootPath, d.name));
    }
    return dirs;
  }

  async #indexOne(dirPath: string, source: SkillSource): Promise<SkillRecord> {
    const file = join(dirPath, SKILL_FILE);
    const raw  = await readFile(file, 'utf8');
    const manifest = parseSkillMd(raw); // throws on invalid frontmatter
    const st = await stat(file);

    const existing = this.repo.findByName(manifest.name);
    const row: SkillRow = {
      id:             existing?.id ?? randomUUID(),
      name:           manifest.name,
      version:        manifest.version,
      description:    manifest.description,
      arg_hint:       manifest.argumentHint ?? null,
      dir_path:       resolve(dirPath),
      source,
      source_url:     existing?.source_url ?? null,
      sha256:         existing?.sha256 ?? null,
      activates_json: JSON.stringify(manifest.activates),
      enabled:        existing?.enabled ?? 1,
      content_mtime:  Math.floor(st.mtimeMs),
      installed_at:   existing?.installed_at ?? Date.now(),
    };
    this.repo.upsertByName(row);
    return this.#rowToRecord(row);
  }

  // ── Queries (DB only — no file I/O) ────────────────────────────────────────

  listAll(): SkillRecord[] {
    return this.repo.listAll().map((r) => this.#rowToRecord(r));
  }

  findByName(name: string): SkillRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.#rowToRecord(row) : null;
  }

  /** Lightweight catalog for prompt injection — enabled skills active in `mode`. */
  listSummariesForMode(mode: SkillActivateMode): SkillSummary[] {
    return this.repo.listEnabled()
      .map((r) => this.#rowToRecord(r))
      .filter((s) => s.activates.includes(mode))
      .map((s) => ({
        name: s.name, description: s.description,
        argumentHint: s.argumentHint, activates: s.activates,
      }));
  }

  // ── Activation: read body lazily from disk (with path guard) ───────────────

  async renderBody(name: string, args: string | undefined): Promise<string> {
    const rec = this.findByName(name);
    if (!rec) throw new SkillNotFoundError(name);
    if (!rec.enabled) throw new Error(`Skill "${name}" is disabled`);

    const file = await this.#guardedSkillFile(rec.dirPath);
    const raw  = await readFile(file, 'utf8');
    const { body } = parseSkillMd(raw);
    return body
      .replaceAll('$ARGUMENTS', args ?? '')
      .replaceAll('${SKILL_DIR}', dirname(file).replaceAll('\\', '/'));
  }

  /**
   * Resolve `<dirPath>/SKILL.md` to its real path and assert it stays inside a
   * known root — defends against a malicious skill symlinking out to read e.g.
   * ~/.ssh into the prompt.
   */
  async #guardedSkillFile(dirPath: string): Promise<string> {
    const canonical = await realpath(join(dirPath, SKILL_FILE));
    const insideRoot = await this.#isInsideAnyRoot(canonical);
    if (!insideRoot) {
      throw new Error(`Skill file escapes configured roots: ${canonical}`);
    }
    return canonical;
  }

  async #isInsideAnyRoot(target: string): Promise<boolean> {
    for (const root of this.roots) {
      try {
        const rootReal = await realpath(root.path);
        if (target === rootReal || target.startsWith(rootReal + sep)) return true;
      } catch { /* root missing — skip */ }
    }
    return false;
  }

  // ── Mutations (writable roots only) ────────────────────────────────────────

  validate(rawMd: string) {
    return validateSkillMd(rawMd);
  }

  /**
   * Install raw SKILL.md text into the user root as `<slug>/SKILL.md`.
   * Atomic: write to a temp dir then rename into place. Returns the record.
   * `extra` carries provenance (sourceUrl / sha256) for market installs.
   */
  async install(
    rawMd: string,
    extra: { sourceUrl?: string; sha256?: string; assets?: Record<string, Uint8Array> } = {},
  ): Promise<SkillRecord> {
    const manifest = parseSkillMd(rawMd); // throws on invalid frontmatter
    const root = this.userRoot;
    const slug = slugify(manifest.name);
    const finalDir = join(root.path, slug);

    const tmpDir = `${finalDir}.tmp-${randomUUID().slice(0, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, SKILL_FILE), rawMd, 'utf8');
    for (const [rel, bytes] of Object.entries(extra.assets ?? {})) {
      const dest = join(tmpDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);

    const st = await stat(join(finalDir, SKILL_FILE));
    const existing = this.repo.findByName(manifest.name);
    const row: SkillRow = {
      id:             existing?.id ?? randomUUID(),
      name:           manifest.name,
      version:        manifest.version,
      description:    manifest.description,
      arg_hint:       manifest.argumentHint ?? null,
      dir_path:       resolve(finalDir),
      source:         root.source,
      source_url:     extra.sourceUrl ?? null,
      sha256:         extra.sha256 ?? null,
      activates_json: JSON.stringify(manifest.activates),
      enabled:        existing?.enabled ?? 1,
      content_mtime:  Math.floor(st.mtimeMs),
      installed_at:   existing?.installed_at ?? Date.now(),
    };
    this.repo.upsertByName(row);
    return this.#rowToRecord(row);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.repo.findByName(name)) throw new SkillNotFoundError(name);
    this.repo.setEnabled(name, enabled ? 1 : 0);
  }

  /** Rename: rewrite frontmatter `name` in the file + update the index key. */
  async rename(name: string, newName: string): Promise<void> {
    const row = this.#requireWritable(name);
    const file = await this.#guardedSkillFile(row.dir_path);
    const raw  = await readFile(file, 'utf8');
    // Replace the first `name:` frontmatter line. Keep it conservative.
    const next = raw.replace(/^(name:\s*).*/m, `$1${newName}`);
    await writeFile(file, next, 'utf8');
    this.repo.rename(name, newName);
  }

  /** Relocate: move the skill directory to a new parent, re-point the index. */
  async relocate(name: string, newParentDir: string): Promise<void> {
    const row = this.#requireWritable(name);
    const dest = join(newParentDir, slugify(name));
    await mkdir(newParentDir, { recursive: true });
    await rename(row.dir_path, dest);
    this.repo.setDirPath(name, resolve(dest));
  }

  /** Remove: delete the skill directory (writable roots) + the index row. */
  async remove(name: string): Promise<void> {
    const row = this.repo.findByName(name);
    if (!row) return;
    if (this.#sourceIsReadonly(row.source)) {
      // builtin skills can be disabled but not deleted
      this.repo.setEnabled(name, 0);
      return;
    }
    await rm(row.dir_path, { recursive: true, force: true });
    this.repo.deleteByName(name);
  }

  /** Absolute skill dir — used by the UI "open in editor / file manager". */
  dirPathOf(name: string): string | null {
    return this.repo.findByName(name)?.dir_path ?? null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #requireWritable(name: string): SkillRow {
    const row = this.repo.findByName(name);
    if (!row) throw new SkillNotFoundError(name);
    if (this.#sourceIsReadonly(row.source)) throw new SkillReadonlyError(name);
    return row;
  }

  #sourceIsReadonly(source: string): boolean {
    return this.roots.some((r) => r.source === source && r.readonly);
  }

  #rowToRecord(row: SkillRow): SkillRecord {
    return {
      id:           row.id,
      name:         row.name,
      version:      row.version,
      description:  row.description,
      argumentHint: row.arg_hint ?? undefined,
      activates:    JSON.parse(row.activates_json) as SkillActivateMode[],
      dirPath:      row.dir_path,
      source:       row.source as SkillSource,
      sourceUrl:    row.source_url ?? undefined,
      enabled:      row.enabled === 1,
      installedAt:  row.installed_at,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}
