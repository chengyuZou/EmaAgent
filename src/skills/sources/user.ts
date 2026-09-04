// sources/user:user 域技能的持久化与对账。目录是事实源,SQL 只是索引。
// 逐技能启停归 skill_enablement(由 SkillEnablementRepo 承载);builtin/project 不写 SQL。
// 市场安装的溯源是目录里的 .market-meta.json(market/installService 写),本文件不读不写。
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillEnablementRepo, SkillRow, SkillsRepo } from '@ema-agent/storage';
import { SkillNotFoundError } from '../errors.js';
import { parseSkillMd } from '../parser.js';
import { listSkillDirectories, resolveChildDirectory, resolveSkillFile } from '../paths.js';
import { type SkillDescriptor, type ParsedSkillMd } from '../types.js';

/** staging 目录前缀;扫描跳过、启动清扫。 */
export const STAGING_PREFIX = '.ema-skill-staging-';

export interface SkillStoreDeps {
  readonly repo: SkillsRepo;
  /** 删除 user 技能时连带清掉它的启停行。 */
  readonly enablement: SkillEnablementRepo;
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
  /** 落位:staging 校验 → 同卷 rename → 写索引。dirName 由调用方消毒(市场 slug 或手动放置名)。 */
  finalizeInstall(stagingDir: string, dirName: string): Promise<SkillDescriptor>;
  /** 删除 user 技能:删目录 + 清索引 + 清启停行。 */
  deleteUserSkill(path: string): Promise<void>;
  /** 清扫 userRoot 下的孤儿 staging 目录(进程死在安装中途的残留)。 */
  sweepOrphanStaging(): Promise<void>;
}

export function createSkillStore(deps: SkillStoreDeps): SkillStore {
  const { repo, enablement, userRoot } = deps;

  async function reconcileUserRoot(): Promise<ReconcileResult> {
    await mkdir(userRoot, { recursive: true });
    const rows = repo.listAll();
    const byPath = new Map(rows.map(row => [row.path, row]));
    const results = await Promise.all((await listSkillDirectories(userRoot)).map(async dir => {
      try {
        const skillFile = await resolveSkillFile(dir);
        const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));
        const existing = byPath.get(skillFile);
        const row: SkillRow = {
          path: skillFile,
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          dir_path: dir,
          size_bytes: await measureSkillDirectory(dir),
          installed_at: existing?.installed_at ?? Date.now(),
        };
        repo.upsert(row);
        return { entry: toDescriptor(row, parsed), skipped: null };
      } catch (error) {
        return { entry: null, skipped: { dir, reason: error instanceof Error ? error.message : String(error) } };
      }
    }));
    const entries = results.flatMap(result => result.entry ? [result.entry] : []);
    const skipped = results.flatMap(result => result.skipped ? [result.skipped] : []);
    const seen = new Set(entries.map(entry => entry.path));

    // 目录消失的索引行删除,连带清掉它的启停行。
    for (const row of rows) {
      if (!seen.has(row.path)) {
        repo.deleteByPath(row.path);
        enablement.deleteByPath(row.path);
      }
    }
    return { entries, skipped };
  }

  async function finalizeInstall(stagingDir: string, dirName: string): Promise<SkillDescriptor> {
    const skillFile = await resolveSkillFile(stagingDir);
    const parsed = parseSkillMd(await readFile(skillFile, 'utf8'));

    const target = join(userRoot, dirName);

    // 更新即替换:先删旧目录再 rename;rm 与 rename 之间目标短暂不存在,对账当缺失处理,下次刷新自愈。
    await rm(target, { recursive: true, force: true });
    await rename(stagingDir, target);

    const row: SkillRow = {
      path: join(target, 'SKILL.md'),
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      dir_path: target,
      size_bytes: await measureSkillDirectory(target),
      installed_at: Date.now(),
    };
    repo.upsert(row);
    return toDescriptor(row, parsed);
  }

  async function deleteUserSkill(path: string): Promise<void> {
    const row = repo.findByPath(path);
    if (!row) throw new SkillNotFoundError(path);
    // 目录必须先过 root 约束才删——索引行可能被手改,不允许借删除越界。
    const dir = await resolveChildDirectory(userRoot, row.dir_path);
    await rm(dir, { recursive: true, force: true });
    repo.deleteByPath(path);
    enablement.deleteByPath(path);
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

/** 递归测量目录总字节,供索引行展示。 */
async function measureSkillDirectory(dir: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    }
  }
  await walk(dir);
  return total;
}

function toDescriptor(row: SkillRow, parsed: ParsedSkillMd): SkillDescriptor {
  return {
    name: row.name,
    path: row.path,
    version: row.version,
    description: row.description,
    whenToUse: parsed.whenToUse,
    suggestedTools: parsed.suggestedTools,
    scope: 'user',
    sizeBytes: row.size_bytes,
  };
}
