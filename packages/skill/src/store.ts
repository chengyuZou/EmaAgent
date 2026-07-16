// 这里管理文件型 Skill 的扫描, 安装, 读取, 重命名和安全删除.
import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SkillRow } from '@ema-agent/storage';
import {
  assertBundleLimits,
  assertRegularFile,
  assertSkillTextSize,
  copyExistingAssets,
  measureSkillDirectory,
  readUtf8Bounded,
  replaceFrontmatterName,
  writeSkillBundle,
} from './bundle-files.js';
import { SkillDirectoryTransaction, recoverSkillDirectoryTransactions } from './directory-transaction.js';
import {
  SkillCollisionError,
  SkillNotFoundError,
  SkillPathError,
  SkillReadonlyError,
} from './errors.js';
import { MAX_SKILL_BYTES } from './limits.js';
import { SkillOperationQueue } from './operation-queue.js';
import {
  isMissingPathError,
  samePath,
  skillSlug,
  validateSkillAssets,
} from './path-policy.js';
import { parseSkillMd, validateSkillMd } from './parser.js';
import { SkillRootBoundary } from './root-boundary.js';
import type {
  ActivatedSkill,
  SkillIndexRepository,
  SkillRecord,
  SkillRoot,
  SkillSource,
  SkillSummary,
} from './types.js';

const SKILL_FILE = 'SKILL.md';
export class SkillStore {
  private readonly operations = new SkillOperationQueue();
  private readonly rootBoundary: SkillRootBoundary;

  constructor(
    private readonly repo: SkillIndexRepository,
    roots: readonly SkillRoot[],
  ) {
    this.rootBoundary = new SkillRootBoundary(roots);
  }

  // 扫描前先恢复未完成的目录事务, 再用磁盘事实重建 SQL 索引.
  async scanAndReconcile(): Promise<{ indexed: number; pruned: number; errors: string[] }> {
    return this.operations.run(async () => {
      const errors: string[] = [];
      const seenNames = new Set<string>();
      let indexed = 0;

      for (const root of this.rootBoundary.roots) {
        if (!root.readonly) {
          const rootPath = await this.rootBoundary.writableRootPath(root);
          errors.push(...await recoverSkillDirectoryTransactions(rootPath));
        }
        const entries = await this.rootBoundary.listSkillDirectories(root.path);
        for (const dirPath of entries) {
          try {
            const record = await this.indexOne(root, dirPath);
            seenNames.add(record.name);
            indexed += 1;
          } catch (error) {
            errors.push(`${dirPath}: ${errorMessage(error)}`);
          }
        }
      }

      let pruned = 0;
      for (const row of this.repo.listAll()) {
        if (!seenNames.has(row.name)) {
          this.repo.deleteByName(row.name);
          pruned += 1;
        }
      }
      return { indexed, pruned, errors };
    });
  }

  listAll(): SkillRecord[] {
    return this.repo.listAll().map(row => this.rowToRecord(row));
  }

  findByName(name: string): SkillRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.rowToRecord(row) : null;
  }

  listSummaries(): SkillSummary[] {
    return this.repo.listEnabled().map(row => ({
      name: row.name,
      description: row.description,
      argumentHint: row.arg_hint ?? undefined,
    }));
  }

  async readRawMd(name: string): Promise<string> {
    return this.operations.run(async () => {
      const row = this.requireRow(name);
      const file = await this.rootBoundary.guardedSkillFile(row);
      return readUtf8Bounded(file, MAX_SKILL_BYTES);
    });
  }

  async activate(name: string, args: string | undefined): Promise<ActivatedSkill> {
    return this.operations.run(async () => {
      const row = this.requireRow(name);
      if (row.enabled !== 1) throw new Error(`Skill "${name}" is disabled`);
      const file = await this.rootBoundary.guardedSkillFile(row);
      const raw = await readUtf8Bounded(file, MAX_SKILL_BYTES);
      const manifest = parseSkillMd(raw);
      return Object.freeze({
        name: manifest.name,
        content: manifest.body
          .replaceAll('$ARGUMENTS', args ?? '')
          .replaceAll('${SKILL_DIR}', dirname(file).replaceAll('\\', '/')),
        allowedTools: Object.freeze([...manifest.allowedTools]),
      });
    });
  }

  /** 兼容只需要正文的管理端调用；Agent 主链使用 activate()。 */
  async renderBody(name: string, args: string | undefined): Promise<string> {
    return (await this.activate(name, args)).content;
  }

  validate(rawMd: string) {
    return validateSkillMd(rawMd);
  }

  async install(
    rawMd: string,
    extra: { sourceUrl?: string; sha256?: string; assets?: Record<string, Uint8Array> } = {},
  ): Promise<SkillRecord> {
    assertSkillTextSize(rawMd);
    const manifest = parseSkillMd(rawMd);
    const assets = validateSkillAssets(extra.assets ?? {});
    assertBundleLimits(rawMd, assets);

    return this.operations.run(async () => {
      const rootPath = await this.rootBoundary.writableRootPath(this.rootBoundary.userRoot);
      const finalPath = join(rootPath, skillSlug(manifest.name));
      const existing = this.repo.findByName(manifest.name);
      const previousPath = await this.resolveInstallPreviousPath(manifest.name, finalPath, existing);
      this.assertNoIndexedPathCollision(manifest.name, finalPath);

      const transaction = await SkillDirectoryTransaction.create(rootPath, skillSlug(manifest.name));
      try {
        await writeSkillBundle(transaction.stagePath, rawMd, assets);
        await transaction.prepare(previousPath, finalPath);
        await transaction.activate();

        const row = await this.buildRow(finalPath, manifest, {
          id: existing?.id ?? randomUUID(),
          source: this.rootBoundary.userRoot.source,
          sourceUrl: extra.sourceUrl ?? null,
          sha256: extra.sha256 ?? null,
          enabled: existing?.enabled ?? 1,
          installedAt: existing?.installed_at ?? Date.now(),
        });
        this.repo.upsertByName(row);
        await transaction.markIndexed();
        await transaction.commit();
        return this.rowToRecord(row);
      } catch (error) {
        return rollbackAndThrow(transaction, error);
      }
    });
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.repo.findByName(name)) throw new SkillNotFoundError(name);
    this.repo.setEnabled(name, enabled ? 1 : 0);
  }

  async rename(name: string, newName: string): Promise<void> {
    if (name === newName) return;
    const trimmedName = newName.trim();
    if (!trimmedName) throw new Error('Skill name cannot be empty');

    await this.operations.run(async () => {
      const row = this.requireWritable(name);
      if (this.repo.findByName(trimmedName)) {
        throw new SkillCollisionError(`Skill name already exists: ${trimmedName}`);
      }
      const sourcePath = await this.rootBoundary.guardedWritableDirectory(row);
      const rootPath = dirname(sourcePath);
      const finalPath = join(rootPath, skillSlug(trimmedName));
      this.assertNoIndexedPathCollision(name, finalPath);

      const raw = await readUtf8Bounded(join(sourcePath, SKILL_FILE), MAX_SKILL_BYTES);
      const nextRaw = replaceFrontmatterName(raw, trimmedName);
      const manifest = parseSkillMd(nextRaw);
      if (manifest.name !== trimmedName) {
        throw new Error(`Skill manifest name was not updated to: ${trimmedName}`);
      }
      const transaction = await SkillDirectoryTransaction.create(rootPath, skillSlug(trimmedName));
      try {
        const assets = await copyExistingAssets(sourcePath, transaction.stagePath, nextRaw);
        assertBundleLimits(nextRaw, assets);
        await transaction.prepare(sourcePath, finalPath);
        await transaction.activate();

        const nextRow = await this.buildRow(finalPath, manifest, {
          id: row.id,
          source: row.source as SkillSource,
          sourceUrl: row.source_url,
          sha256: null,
          enabled: row.enabled,
          installedAt: row.installed_at,
        });
        this.repo.replaceByName(name, nextRow);
        await transaction.markIndexed();
        await transaction.commit();
      } catch (error) {
        return rollbackAndThrow(transaction, error);
      }
    });
  }

  async relocate(name: string, newParentDir: string): Promise<void> {
    await this.operations.run(async () => {
      const row = this.requireWritable(name);
      const sourcePath = await this.rootBoundary.guardedWritableDirectory(row);
      const requestedRoot = await realpath(newParentDir).catch(() => null);
      if (!requestedRoot) throw new SkillPathError(`Skill target root does not exist: ${newParentDir}`);

      const writableRoots = await this.rootBoundary.writableRootPaths();
      const matchedRoot = writableRoots.find(root => samePath(root, requestedRoot));
      if (!matchedRoot) {
        throw new SkillPathError('Skill can only move to a configured writable root');
      }
      if (samePath(dirname(sourcePath), matchedRoot)) return;

      // V1 只有一个 writable root. 跨 root 需要双根 journal, 不能伪装成安全 rename.
      throw new SkillPathError('Cross-root Skill relocation is not supported in V1');
    });
  }

  async remove(name: string): Promise<void> {
    await this.operations.run(async () => {
      const row = this.repo.findByName(name);
      if (!row) return;
      if (this.rootBoundary.sourceIsReadonly(row.source)) {
        this.repo.setEnabled(name, 0);
        return;
      }

      let directory: string | null = null;
      try {
        directory = await this.rootBoundary.guardedWritableDirectory(row);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }

      // 先删可重建索引, 再删文件. 文件删除失败时下次 scan 会把索引恢复, 不丢正文.
      this.repo.deleteByName(name);
      if (directory) await rm(directory, { recursive: true, force: false });
    });
  }

  dirPathOf(name: string): string | null {
    return this.repo.findByName(name)?.dir_path ?? null;
  }

  private async indexOne(root: SkillRoot, dirPath: string): Promise<SkillRecord> {
    const guardedDir = await this.rootBoundary.guardedRootChild(root, dirPath);
    const file = join(guardedDir, SKILL_FILE);
    await assertRegularFile(file);
    const raw = await readUtf8Bounded(file, MAX_SKILL_BYTES);
    const manifest = parseSkillMd(raw);
    const fileStat = await stat(file);
    const existing = this.repo.findByName(manifest.name);
    const size = await measureSkillDirectory(guardedDir);

    const row: SkillRow = {
      id: existing?.id ?? randomUUID(),
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      arg_hint: manifest.argumentHint ?? null,
      dir_path: guardedDir,
      source: root.source,
      source_url: existing?.source_url ?? null,
      sha256: existing?.sha256 ?? null,
      size_bytes: size,
      enabled: existing?.enabled ?? 1,
      content_mtime: Math.floor(fileStat.mtimeMs),
      installed_at: existing?.installed_at ?? Date.now(),
    };
    this.repo.upsertByName(row);
    return this.rowToRecord(row);
  }

  private async resolveInstallPreviousPath(
    name: string,
    finalPath: string,
    existing: SkillRow | null,
  ): Promise<string | null> {
    if (existing && !this.rootBoundary.sourceIsReadonly(existing.source)) {
      const previous = await this.rootBoundary.guardedWritableDirectory(existing);
      if (!samePath(dirname(previous), dirname(finalPath))) {
        throw new SkillPathError('Existing Skill is not in the active writable root');
      }
      return previous;
    }

    const finalStat = await lstat(finalPath).catch(error => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!finalStat) return null;
    if (!finalStat.isDirectory() || finalStat.isSymbolicLink()) {
      throw new SkillCollisionError(`Skill install target is not a regular directory: ${finalPath}`);
    }
    const guardedFinalPath = await this.rootBoundary.guardedRootChild(
      this.rootBoundary.userRoot,
      finalPath,
    );
    const skillFile = join(guardedFinalPath, SKILL_FILE);
    await assertRegularFile(skillFile);
    const raw = await readUtf8Bounded(skillFile, MAX_SKILL_BYTES);
    const manifest = parseSkillMd(raw);
    if (manifest.name !== name) {
      throw new SkillCollisionError(
        `Skill slug collision: "${name}" and "${manifest.name}" both map to ${finalPath}`,
      );
    }
    return guardedFinalPath;
  }

  private assertNoIndexedPathCollision(name: string, finalPath: string): void {
    const collision = this.repo.listAll().find(row =>
      row.name !== name && samePath(resolve(row.dir_path), resolve(finalPath)),
    );
    if (collision) {
      throw new SkillCollisionError(
        `Skill slug collision: "${name}" conflicts with indexed Skill "${collision.name}"`,
      );
    }
  }

  private async buildRow(
    dirPath: string,
    manifest: ReturnType<typeof parseSkillMd>,
    identity: {
      id: string;
      source: SkillSource;
      sourceUrl: string | null;
      sha256: string | null;
      enabled: number;
      installedAt: number;
    },
  ): Promise<SkillRow> {
    const file = join(dirPath, SKILL_FILE);
    const fileStat = await stat(file);
    return {
      id: identity.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      arg_hint: manifest.argumentHint ?? null,
      dir_path: resolve(dirPath),
      source: identity.source,
      source_url: identity.sourceUrl,
      sha256: identity.sha256,
      size_bytes: await measureSkillDirectory(dirPath),
      enabled: identity.enabled,
      content_mtime: Math.floor(fileStat.mtimeMs),
      installed_at: identity.installedAt,
    };
  }

  private requireRow(name: string): SkillRow {
    const row = this.repo.findByName(name);
    if (!row) throw new SkillNotFoundError(name);
    return row;
  }

  private requireWritable(name: string): SkillRow {
    const row = this.requireRow(name);
    if (this.rootBoundary.sourceIsReadonly(row.source)) throw new SkillReadonlyError(name);
    return row;
  }

  private rowToRecord(row: SkillRow): SkillRecord {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      argumentHint: row.arg_hint ?? undefined,
      dirPath: row.dir_path,
      source: row.source as SkillSource,
      sourceUrl: row.source_url ?? undefined,
      sizeBytes: row.size_bytes,
      enabled: row.enabled === 1,
      installedAt: row.installed_at,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackAndThrow(
  transaction: SkillDirectoryTransaction,
  originalError: unknown,
): Promise<never> {
  try {
    await transaction.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      `Skill directory rollback failed after: ${errorMessage(originalError)}`,
    );
  }
  throw originalError;
}

export { SkillCollisionError, SkillNotFoundError, SkillPathError, SkillReadonlyError } from './errors.js';
