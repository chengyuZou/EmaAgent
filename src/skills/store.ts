// SkillStore:user 域技能的持久化与对账。目录是事实源,SQL 只是索引/溯源。
// 不含启用状态(Settings deny-list);builtin/project 域不写 SQL(project 原位只读)。
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillRow, SkillsRepo } from '@ema-agent/storage';
import { SkillNotFoundError } from './errors.js';
import { parseSkillMd, readSkillFileBounded } from './parser.js';
import { listSkillDirectories, resolveChildDirectory, resolveSkillFile, skillSlug } from './paths.js';
import {
  MAX_SKILL_BUNDLE_FILES,
  type SkillDescriptor,
  type SkillInstallProvenance,
  type SkillManifest,
} from './types.js';

/** staging 目录前缀;扫描跳过、启动清扫。 */
export const STAGING_PREFIX = '.ema-skill-staging-';
/** 站点安装目录名前缀(site_<siteId>_<entryId>)。 */
const SITE_DIR_PREFIX = 'site_';

export interface SkillStoreDeps {
  readonly repo: SkillsRepo;
  /** <profileDir>/skills;不存在时自动创建。 */
  readonly userRoot: string;
}

export interface ReconcileResult {
  readonly entries: SkillDescriptor[];
  /** 损坏目录的跳过记录,供 UI/日志展示;不拖垮整轮对账。 */
  readonly skipped: readonly { dir: string; reason: string }[];
}

export interface SkillStore {
  /** user 根目录 ⇄ SQL 索引对账;幂等,可每次刷新都跑。 */
  reconcileUserRoot(): Promise<ReconcileResult>;
  /** 安装落位:staging 校验 → 同卷 rename → 写索引 + 溯源。 */
  finalizeInstall(
    stagingDir: string,
    provenance: SkillInstallProvenance,
  ): Promise<SkillDescriptor>;
  /** 删除 user 技能:删目录 + 清索引。 */
  deleteUserSkill(key: string): Promise<void>;
  /** 清扫 userRoot 下的孤儿 staging 目录(进程死在安装中途的残留)。 */
  sweepOrphanStaging(): Promise<void>;
}

export function createSkillStore(deps: SkillStoreDeps): SkillStore {
  const { repo, userRoot } = deps;

  async function reconcileUserRoot(): Promise<ReconcileResult> {
    await mkdir(userRoot, { recursive: true });
    const rows = repo.listAll();
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const entries: SkillDescriptor[] = [];
    const skipped: { dir: string; reason: string }[] = [];

    for (const dir of await listSkillDirectories(userRoot)) {
      try {
        const skillFile = await resolveSkillFile(dir);
        const manifest = parseSkillMd(await readSkillFileBounded(skillFile));
        const info = await stat(skillFile);
        const id = stableIdForDir(dir);
        seen.add(id);

        const existing = rowsById.get(id);
        const row: SkillRow = {
          id,
          name: manifest.name,
          // 站点安装的版本以站点索引为准(更新对账事实源),不从 frontmatter 回写。
          version: existing?.site_id ? existing.version : manifest.version,
          description: manifest.description,
          arg_hint: manifest.argumentHint ?? null,
          dir_path: dir,
          source: 'user',
          // 溯源字段只从既有行继承;对账不产生溯源。
          source_url: existing?.source_url ?? null,
          sha256: existing?.sha256 ?? null,
          site_id: existing?.site_id ?? null,
          site_entry_id: existing?.site_entry_id ?? null,
          size_bytes: await measureSkillDirectory(dir),
          content_mtime: Math.floor(info.mtimeMs),
          installed_at: existing?.installed_at ?? Date.now(),
        };
        repo.upsertById(row);
        entries.push(toDescriptor(row, manifest));
      } catch (error) {
        skipped.push({ dir, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    // 目录消失的索引行删除;不主动清理悬垂 disabledKeys(由 UI 层标注)。
    for (const row of rows) {
      if (!seen.has(row.id)) repo.deleteById(row.id);
    }
    return { entries, skipped };
  }

  async function finalizeInstall(
    stagingDir: string,
    provenance: SkillInstallProvenance,
  ): Promise<SkillDescriptor> {
    const skillFile = await resolveSkillFile(stagingDir);
    const manifest = parseSkillMd(await readSkillFileBounded(skillFile));
    const info = await stat(skillFile);

    const installKey = provenance.kind === 'site'
      ? `${SITE_DIR_PREFIX}${provenance.siteId}_${provenance.siteEntryId}`
      : skillSlug(manifest.name);
    const id = provenance.kind === 'site' ? installKey : stableIdForDir(join(userRoot, installKey));
    const target = join(userRoot, installKey);

    // 更新即替换:先删旧目录再 rename;rename 同卷原子,读盘只读到旧或新。
    await rm(target, { recursive: true, force: true });
    await rename(stagingDir, target);

    const row: SkillRow = {
      id,
      name: manifest.name,
      version: provenance.kind === 'site' ? provenance.version : manifest.version,
      description: manifest.description,
      arg_hint: manifest.argumentHint ?? null,
      dir_path: target,
      source: 'user',
      source_url: provenance.kind === 'site' ? provenance.bundleUrl : null,
      sha256: provenance.kind === 'site' ? provenance.bundleSha256 : null,
      site_id: provenance.kind === 'site' ? provenance.siteId : null,
      site_entry_id: provenance.kind === 'site' ? provenance.siteEntryId : null,
      size_bytes: await measureSkillDirectory(target),
      content_mtime: Math.floor(info.mtimeMs),
      installed_at: Date.now(),
    };
    repo.upsertById(row);
    return toDescriptor(row, manifest);
  }

  async function deleteUserSkill(key: string): Promise<void> {
    if (!key.startsWith('user:')) {
      throw new SkillNotFoundError(key);
    }
    const id = key.slice('user:'.length);
    const row = repo.findById(id);
    if (!row) throw new SkillNotFoundError(key);
    // 目录必须先过 root 约束才删——索引行可能被手改,不允许借删除越界。
    const dir = await resolveChildDirectory(userRoot, row.dir_path);
    await rm(dir, { recursive: true, force: true });
    repo.deleteById(id);
  }

  async function sweepOrphanStaging(): Promise<void> {
    await mkdir(userRoot, { recursive: true });
    let entries;
    try {
      entries = await readdir(userRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
        await rm(join(userRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  return { reconcileUserRoot, finalizeInstall, deleteUserSkill, sweepOrphanStaging };
}

/** 站点安装 id = 目录名(site_<siteId>_<entryId>);手动放置 = 归一化路径哈希(改名 = 新技能)。 */
function stableIdForDir(dir: string): string {
  const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!;
  if (name.startsWith(SITE_DIR_PREFIX)) return name;
  return createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

/** 递归测量目录总字节;文件数超上限视为损坏(对账跳过)。 */
async function measureSkillDirectory(dir: string): Promise<number> {
  let total = 0;
  let count = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count += 1;
        if (count > MAX_SKILL_BUNDLE_FILES) {
          throw new Error(`技能目录文件数超过上限(${MAX_SKILL_BUNDLE_FILES}): ${dir}`);
        }
        total += (await stat(full)).size;
      }
    }
  }
  await walk(dir);
  return total;
}

function toDescriptor(row: SkillRow, manifest: SkillManifest): SkillDescriptor {
  return {
    key: `user:${row.id}`,
    name: row.name,
    callName: row.name,
    version: row.version,
    description: row.description,
    argumentHint: row.arg_hint ?? undefined,
    whenToUse: manifest.whenToUse,
    allowedToolPatterns: manifest.allowedTools,
    rootPath: row.dir_path,
    scope: 'user',
    provenance: row.site_id
      ? {
          kind: 'site',
          siteId: row.site_id,
          siteEntryId: row.site_entry_id ?? '',
          version: row.version,
          bundleUrl: row.source_url ?? '',
          bundleSha256: row.sha256 ?? '',
        }
      : { kind: 'localDirectory' },
  };
}
