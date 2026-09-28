// builtin/user 的目录对账, 安装, 删除和启停; project 目录不由此 Store 管理.
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillsRepo, type Database, type SkillRow } from '@ema-agent/storage';
import { SkillNotFoundError, SkillPathError } from './errors.js';
import { parseSkillMd } from './parser.js';
import { listSkillDirectories, resolveChildDirectory, resolveSkillFile } from './paths.js';
import type { ParsedSkillMd, SkillDescriptor } from './types.js';

/** 安装只在 userRoot 内创建 staging, 扫描跳过这些未完成目录. */
export const STAGING_PREFIX = '.ema-skill-staging-';

export class SkillStore {
  private readonly repo: SkillsRepo;

  constructor(
    db: Database,
    private readonly userRoot: string,
    private readonly builtinRoot: string,
  ) {
    this.repo = new SkillsRepo(db.sqlite);
  }

  async reconcileUserRoot(): Promise<SkillDescriptor[]> {
    await mkdir(this.userRoot, { recursive: true });
    const rows = this.repo.listByScope('user');
    const byPath = new Map(rows.map(row => [row.path, row]));
    const directories = await listSkillDirectories(this.userRoot);
    const results = await Promise.all(directories.map(async dir => {
      try {
        const skillFile = await resolveSkillFile(dir);
        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        const existing = byPath.get(skillFile);
        const row: SkillRow = {
          path: skillFile,
          scope: 'user',
          enabled: existing?.enabled ?? 1,
          name: parsed.name,
          version: parsed.version ?? null,
          description: parsed.description,
          dir_path: dir,
          size_bytes: await measureSkillDirectory(dir),
          installed_at: existing?.installed_at ?? Date.now(),
        };
        this.repo.upsert(row);
        return toDescriptor(row, parsed);
      } catch {
        return null;
      }
    }));

    // 只清理 user 的消失目录. 解析失败仍保留索引和 enabled, 修复后沿用用户选择.
    const present = new Set(directories);
    for (const row of rows) {
      if (!present.has(row.dir_path)) this.repo.deleteByPath(row.path);
    }
    this.repo.migrateEnablement();
    return results.flatMap(entry => entry ? [entry] : []);
  }

  async reconcileBuiltinRoot(): Promise<SkillDescriptor[]> {
    // 保留空根目录, 删除最后一个 builtin 后重启不会触发宿主的首次铺设.
    await mkdir(this.builtinRoot, { recursive: true });
    const rows = this.repo.listByScope('builtin');
    const byPath = new Map(rows.map(row => [row.path, row]));
    const directories = await listSkillDirectories(this.builtinRoot);
    const results = await Promise.all(directories.map(async dir => {
      try {
        const skillFile = await resolveSkillFile(dir);
        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        const existing = byPath.get(skillFile);
        const row: SkillRow = {
          path: skillFile,
          scope: 'builtin',
          enabled: existing?.enabled ?? 1,
          name: parsed.name,
          version: parsed.version ?? null,
          description: parsed.description,
          dir_path: dir,
          size_bytes: await measureSkillDirectory(dir),
          installed_at: existing?.installed_at ?? Date.now(),
        };
        this.repo.upsert(row);
        return toDescriptor(row, parsed);
      } catch {
        return null;
      }
    }));

    const present = new Set(directories);
    for (const row of rows) {
      if (!present.has(row.dir_path)) this.repo.deleteByPath(row.path);
    }
    this.repo.migrateEnablement();
    return results.flatMap(entry => entry ? [entry] : []);
  }

  async finalizeInstall(stagingDir: string, dirName: string): Promise<SkillDescriptor> {
    const skillFile = await resolveSkillFile(stagingDir);
    const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
    const target = join(this.userRoot, dirName);
    const installedPath = join(target, 'SKILL.md');
    const existing = this.repo.findByPath(installedPath);

    // 安装目标来自市场目录名, 文件替换完成后才更新索引, 保留原有启停状态.
    await rm(target, { recursive: true, force: true });
    await rename(stagingDir, target);
    const row: SkillRow = {
      path: installedPath,
      scope: 'user',
      enabled: existing?.enabled ?? 1,
      name: parsed.name,
      version: parsed.version ?? null,
      description: parsed.description,
      dir_path: target,
      size_bytes: await measureSkillDirectory(target),
      installed_at: existing?.installed_at ?? Date.now(),
    };
    this.repo.upsert(row);
    return toDescriptor(row, parsed);
  }

  async deleteUserSkill(path: string): Promise<void> {
    const row = this.repo.findByPath(path);
    if (!row) throw new SkillNotFoundError(path);
    if (row.scope !== 'user') throw new SkillPathError('此入口只能删除用户技能');
    const dir = await resolveChildDirectory(this.userRoot, row.dir_path);
    await rm(dir, { recursive: true, force: true });
    this.repo.deleteByPath(path);
  }

  async deleteBuiltinSkill(path: string): Promise<void> {
    const row = this.repo.findByPath(path);
    if (!row) throw new SkillNotFoundError(path);
    if (row.scope !== 'builtin') throw new SkillPathError('此入口只能删除内置技能');
    // 只删除 profile 下的本地副本, 不碰发行包种子或 builtin 根目录.
    const dir = await resolveChildDirectory(this.builtinRoot, row.dir_path);
    await rm(dir, { recursive: true, force: true });
    this.repo.deleteByPath(path);
  }

  setEnabled(path: string, enabled: boolean): void {
    if (!this.repo.findByPath(path)) throw new SkillNotFoundError(path);
    this.repo.setEnabled(path, enabled ? 1 : 0);
  }

  listDisabledPaths(): string[] {
    return this.repo.listDisabledPaths();
  }

  async sweepOrphanStaging(): Promise<void> {
    await mkdir(this.userRoot, { recursive: true });
    const entries = await readdir(this.userRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
        await rm(join(this.userRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
}

/** 目录大小用于技能列表展示, 不参与 Prompt 和启停判定. */
async function measureSkillDirectory(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await measureSkillDirectory(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

function toDescriptor(row: SkillRow, parsed: ParsedSkillMd): SkillDescriptor {
  return {
    name: row.name,
    path: row.path,
    ...(row.version !== null ? { version: row.version } : {}),
    description: row.description,
    whenToUse: parsed.whenToUse,
    scope: row.scope,
    sizeBytes: row.size_bytes,
  };
}
