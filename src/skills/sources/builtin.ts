// sources/builtin:内置技能的物化对账与扫描。
// 随包资源 → <profileDir>/resources/skills;指纹 marker 对账(Codex install_system_skills 模式):
// marker 匹配跳过,不匹配整目录重写(临时目录 + rename 交换,不留半成品)。
// builtin 不落 SQL、默认启用;物化失败降级 warning,SkillPool 缺内置技能继续运行。
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkillMd, readSkillFileBounded } from '../parser.js';
import { listSkillDirectories, resolveSkillFile } from '../paths.js';
import type { SkillDescriptor } from '../types.js';

export interface BuiltinScanDeps {
  /** 随包技能源目录(发布资源,只读)。 */
  readonly bundledSource: string;
  /** 物化目标(<profileDir>/resources/skills)。 */
  readonly materializedRoot: string;
}

const MARKER_FILE = '.ema-skill-marker.json';

export async function scanBuiltinSkills(deps: BuiltinScanDeps): Promise<SkillDescriptor[]> {
  try {
    await materializeIfStale(deps);
    return await scanMaterialized(deps.materializedRoot);
  } catch (error) {
    console.warn('[skills] builtin 物化/扫描失败,降级为无内置技能:', error);
    return [];
  }
}

/** 指纹对账:匹配跳过;不匹配整目录重写。 */
async function materializeIfStale(deps: BuiltinScanDeps): Promise<void> {
  const fingerprint = await computeSourceFingerprint(deps.bundledSource);
  const markerPath = join(deps.materializedRoot, MARKER_FILE);
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { fingerprint?: string };
    if (marker.fingerprint === fingerprint) return;
  } catch {
    // marker 缺失/损坏 → 全量物化。
  }

  const staging = `${deps.materializedRoot}.staging-${createHash('sha256')
    .update(String(process.pid))
    .digest('hex')
    .slice(0, 8)}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await cp(deps.bundledSource, staging, { recursive: true });
  await writeFile(join(staging, MARKER_FILE), JSON.stringify({ fingerprint }), 'utf8');

  await rm(deps.materializedRoot, { recursive: true, force: true });
  await rename(staging, deps.materializedRoot);
}

/** 源指纹:全部文件的相对路径+内容哈希的总哈希;内容不变则物化跳过。 */
async function computeSourceFingerprint(source: string): Promise<string> {
  const hash = createHash('sha256');
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk(source, '');
  files.sort();
  for (const rel of files) {
    const full = join(source, ...rel.split('/'));
    hash.update(rel);
    hash.update(' ');
    hash.update(String((await stat(full)).size));
    hash.update(' ');
    hash.update(await readFile(full));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function scanMaterialized(root: string): Promise<SkillDescriptor[]> {
  const descriptors: SkillDescriptor[] = [];
  for (const dir of await listSkillDirectories(root)) {
    try {
      const skillFile = await resolveSkillFile(dir);
      const manifest = parseSkillMd(await readSkillFileBounded(skillFile));
      const slug = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!;
      descriptors.push({
        key: `builtin:${slug}`,
        name: manifest.name,
        callName: manifest.name,
        version: manifest.version,
        description: manifest.description,
        ...(manifest.argumentHint !== undefined ? { argumentHint: manifest.argumentHint } : {}),
        ...(manifest.whenToUse !== undefined ? { whenToUse: manifest.whenToUse } : {}),
        allowedToolPatterns: manifest.allowedTools,
        rootPath: dir,
        scope: 'builtin',
      });
    } catch (error) {
      console.warn(`[skills] 内置技能损坏跳过: ${dir}`, error);
    }
  }
  return descriptors;
}
