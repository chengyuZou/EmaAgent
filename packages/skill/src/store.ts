import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { SkillsRepo, SkillRow } from '@ema-agent/storage';
import { parseSkillMd, validateSkillMd } from './parser.js';
import type {
  SkillRecord, SkillRoot, SkillSource, SkillSummary,
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
// 文件支撑的 skill 存储。事实来源是磁盘上的 `<root>/<slug>/SKILL.md`;
// SQL 索引(SkillsRepo)是缓存,让 catalog 无需打开每个文件即可构建。
// body 在激活时懒读(renderBody)。
//
// root 按序扫描;后扫的 root 覆盖同名 skill,故按 [builtin, user] 顺序建 root,
// 让用户定制优先。

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

  // ── 对账(启动 + 外部编辑后)────────────────────────────────────────────
  //
  // 扫描每个 root,把有效 skill upsert 进索引,修剪目录已不存在的行。
  // 返回 { indexed, pruned, errors }。

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

    // 修剪磁盘 skill 已不存在的索引行(文件被带外删了)。
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
      return []; // root 缺失 -> 无 skill
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
    const manifest = parseSkillMd(raw); // 无效 frontmatter 时抛错
    const st = await stat(file);

    const existing = this.repo.findByName(manifest.name);
    const row: SkillRow = {
      id:            existing?.id ?? randomUUID(),
      name:          manifest.name,
      version:       manifest.version,
      description:   manifest.description,
      arg_hint:      manifest.argumentHint ?? null,
      dir_path:      resolve(dirPath),
      source,
      source_url:    existing?.source_url ?? null,
      sha256:        existing?.sha256 ?? null,
      size_bytes:    await dirSize(dirPath),
      enabled:       existing?.enabled ?? 1,
      content_mtime: Math.floor(st.mtimeMs),
      installed_at:  existing?.installed_at ?? Date.now(),
    };
    this.repo.upsertByName(row);
    return this.#rowToRecord(row);
  }

  // ── 查询(仅 DB - 无文件 I/O)────────────────────────────────────────────

  listAll(): SkillRecord[] {
    return this.repo.listAll().map((r) => this.#rowToRecord(r));
  }

  findByName(name: string): SkillRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.#rowToRecord(row) : null;
  }

  /** 供 prompt 注入的轻量 catalog - 所有启用的 skill。 */
  listSummaries(): SkillSummary[] {
    return this.repo.listEnabled().map((r) => ({
      name:         r.name,
      description:  r.description,
      argumentHint: r.arg_hint ?? undefined,
    }));
  }

  // ── 读原始 SKILL.md 供查看(frontmatter + body,无替换)───────────────────

  async readRawMd(name: string): Promise<string> {
    const rec = this.findByName(name);
    if (!rec) throw new SkillNotFoundError(name);
    const file = await this.#guardedSkillFile(rec.dirPath);
    return readFile(file, 'utf8');
  }

  // ── 激活:从磁盘懒读 body(带路径守卫)──────────────────────────────────────

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
   * 把 `<dirPath>/SKILL.md` 解析为真实路径并断言它在已知 root 内 -
   * 防御恶意 skill 软链出界,把如 ~/.ssh 读进 prompt。
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
      } catch { /* root 缺失 - 跳过 */ }
    }
    return false;
  }

  // ── 变更(仅可写 root)────────────────────────────────────────────────────

  validate(rawMd: string) {
    return validateSkillMd(rawMd);
  }

  /**
   * 把原始 SKILL.md 文本装进 user root 作 `<slug>/SKILL.md`。
   * 原子:写到临时目录再 rename 到位。返回 record。
   * `extra` 带来源(sourceUrl / sha256),供 market 安装用。
   */
  async install(
    rawMd: string,
    extra: { sourceUrl?: string; sha256?: string; assets?: Record<string, Uint8Array> } = {},
  ): Promise<SkillRecord> {
    const manifest = parseSkillMd(rawMd); // 无效 frontmatter 时抛错
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
      id:            existing?.id ?? randomUUID(),
      name:          manifest.name,
      version:       manifest.version,
      description:   manifest.description,
      arg_hint:      manifest.argumentHint ?? null,
      dir_path:      resolve(finalDir),
      source:        root.source,
      source_url:    extra.sourceUrl ?? null,
      sha256:        extra.sha256 ?? null,
      size_bytes:    await dirSize(finalDir),
      enabled:       existing?.enabled ?? 1,
      content_mtime: Math.floor(st.mtimeMs),
      installed_at:  existing?.installed_at ?? Date.now(),
    };
    this.repo.upsertByName(row);
    return this.#rowToRecord(row);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.repo.findByName(name)) throw new SkillNotFoundError(name);
    this.repo.setEnabled(name, enabled ? 1 : 0);
  }

  /** 重命名:改写文件里的 frontmatter `name` + 更新索引键。 */
  async rename(name: string, newName: string): Promise<void> {
    const row = this.#requireWritable(name);
    const file = await this.#guardedSkillFile(row.dir_path);
    const raw  = await readFile(file, 'utf8');
    // 替换第一行 `name:` frontmatter。保守起见。
    const next = raw.replace(/^(name:\s*).*/m, `$1${newName}`);
    await writeFile(file, next, 'utf8');
    this.repo.rename(name, newName);
  }

  /** 迁移:把 skill 目录移到新父目录,重指索引。 */
  async relocate(name: string, newParentDir: string): Promise<void> {
    const row = this.#requireWritable(name);
    const dest = join(newParentDir, slugify(name));
    await mkdir(newParentDir, { recursive: true });
    await rename(row.dir_path, dest);
    this.repo.setDirPath(name, resolve(dest));
  }

  /** 移除:删 skill 目录(可写 root)+ 索引行。 */
  async remove(name: string): Promise<void> {
    const row = this.repo.findByName(name);
    if (!row) return;
    if (this.#sourceIsReadonly(row.source)) {
      // builtin skill 可禁用但不能删
      this.repo.setEnabled(name, 0);
      return;
    }
    await rm(row.dir_path, { recursive: true, force: true });
    this.repo.deleteByName(name);
  }

  /** skill 绝对目录 - UI"在编辑器/文件管理器打开"用。 */
  dirPathOf(name: string): string | null {
    return this.repo.findByName(name)?.dir_path ?? null;
  }

  // ── 私有 ────────────────────────────────────────────────────────────────

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
      dirPath:      row.dir_path,
      source:       row.source as SkillSource,
      sourceUrl:    row.source_url ?? undefined,
      sizeBytes:    row.size_bytes,
      enabled:      row.enabled === 1,
      installedAt:  row.installed_at,
    };
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

/** skill 目录的递归总字节(SKILL.md + assets)。 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(p);
    } else if (e.isFile()) {
      try { total += (await stat(p)).size; } catch { /* 忽略 */ }
    }
  }
  return total;
}
