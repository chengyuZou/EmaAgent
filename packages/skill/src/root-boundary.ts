// 这里把 Skill 的数据库路径限制为配置 root 下的直接普通目录和普通文件.
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SkillRow } from '@ema-agent/storage';
import { assertRegularFile } from './bundle-files.js';
import { SkillPathError, SkillReadonlyError } from './errors.js';
import { samePath } from './path-policy.js';
import type { SkillRoot } from './types.js';

const SKILL_FILE = 'SKILL.md';
const INTERNAL_ENTRY_PREFIX = '.ema-skill-';

export class SkillRootBoundary {
  constructor(readonly roots: readonly SkillRoot[]) {}

  get userRoot(): SkillRoot {
    const root = this.roots.find(candidate => !candidate.readonly);
    if (!root) throw new Error('SkillStore: no writable user root configured');
    return root;
  }

  sourceIsReadonly(source: string): boolean {
    return this.roots.some(root => root.source === source && root.readonly === true);
  }

  async writableRootPaths(): Promise<string[]> {
    return Promise.all(this.roots.filter(root => !root.readonly).map(root => this.writableRootPath(root)));
  }

  async writableRootPath(root: SkillRoot): Promise<string> {
    if (root.readonly) throw new SkillReadonlyError(root.source);
    await mkdir(root.path, { recursive: true });
    return realpath(root.path);
  }

  async listSkillDirectories(rootPath: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith(INTERNAL_ENTRY_PREFIX))
      .map(entry => join(rootPath, entry.name));
  }

  async guardedSkillFile(row: SkillRow): Promise<string> {
    const root = this.roots.find(candidate => candidate.source === row.source);
    if (!root) throw new SkillPathError(`No configured root for Skill source: ${row.source}`);
    const directory = await this.guardedRootChild(root, row.dir_path);
    const file = join(directory, SKILL_FILE);
    await assertRegularFile(file);
    const canonicalFile = await realpath(file);
    if (!samePath(dirname(canonicalFile), directory)) {
      throw new SkillPathError(`Skill file escapes its directory: ${canonicalFile}`);
    }
    return canonicalFile;
  }

  async guardedWritableDirectory(row: SkillRow): Promise<string> {
    const root = this.roots.find(candidate => candidate.source === row.source && !candidate.readonly);
    if (!root) throw new SkillReadonlyError(row.name);
    return this.guardedRootChild(root, row.dir_path);
  }

  async guardedRootChild(root: SkillRoot, targetPath: string): Promise<string> {
    const rootPath = root.readonly
      ? await realpath(root.path)
      : await this.writableRootPath(root);
    const targetStat = await lstat(targetPath);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new SkillPathError(`Skill directory must be a regular directory: ${targetPath}`);
    }
    const canonicalTarget = await realpath(targetPath);
    if (!samePath(dirname(canonicalTarget), rootPath)) {
      throw new SkillPathError(`Skill directory escapes configured root: ${canonicalTarget}`);
    }
    return canonicalTarget;
  }
}
