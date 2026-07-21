// 这里负责 Skill Bundle 的有界读取, 安全复制, 持久写入和 manifest 文本改写.
import { lstat, mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { SkillPathError } from './errors.js';
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BYTES,
} from './limits.js';
import { samePath, validateSkillAssets } from './path-policy.js';

const SKILL_FILE = 'SKILL.md';

export type SkillAssetEntry = readonly [string, Uint8Array];

export async function writeSkillBundle(
  stagePath: string,
  rawMd: string,
  assets: readonly SkillAssetEntry[],
): Promise<void> {
  await writeDurableFile(join(stagePath, SKILL_FILE), rawMd);
  for (const [relativePath, bytes] of assets) {
    const destination = join(stagePath, ...relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeDurableFile(destination, bytes);
  }
  await syncDirectory(stagePath);
}

export async function copyExistingAssets(
  sourcePath: string,
  stagePath: string,
  rawMd: string,
): Promise<SkillAssetEntry[]> {
  const assets: Record<string, Uint8Array> = {};
  const budget = { files: 0, bytes: Buffer.byteLength(rawMd, 'utf8') };
  await collectAssets(sourcePath, sourcePath, assets, budget);
  const entries = validateSkillAssets(assets);
  await writeSkillBundle(stagePath, rawMd, entries);
  return entries;
}

export async function measureSkillDirectory(dirPath: string): Promise<number> {
  let total = 0;
  let files = 0;

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isSymbolicLink()) throw new SkillPathError(`Skill directory contains symlink: ${fullPath}`);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files += 1;
        total += (await stat(fullPath)).size;
        if (files > MAX_SKILL_BUNDLE_FILES + 1 || total > MAX_SKILL_BUNDLE_BYTES) {
          throw new SkillPathError('Skill directory exceeds file count or byte limit');
        }
      } else {
        throw new SkillPathError(`Skill directory contains unsupported entry: ${fullPath}`);
      }
    }
  }

  await visit(dirPath);
  return total;
}

export async function readUtf8Bounded(filePath: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > maxBytes) {
    throw new SkillPathError(`Skill file exceeds ${maxBytes} byte limit: ${filePath}`);
  }
  return readFile(filePath, 'utf8');
}

export async function assertRegularFile(filePath: string): Promise<void> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new SkillPathError(`Skill file must be a regular file: ${filePath}`);
  }
}

export function assertSkillTextSize(rawMd: string): void {
  const bytes = Buffer.byteLength(rawMd, 'utf8');
  if (bytes > MAX_SKILL_BYTES) {
    throw new SkillPathError(`SKILL.md exceeds ${MAX_SKILL_BYTES} byte limit`);
  }
}

export function assertBundleLimits(rawMd: string, assets: readonly SkillAssetEntry[]): void {
  if (assets.length > MAX_SKILL_BUNDLE_FILES) {
    throw new SkillPathError(`Skill Bundle exceeds ${MAX_SKILL_BUNDLE_FILES} asset limit`);
  }
  let total = Buffer.byteLength(rawMd, 'utf8');
  for (const [, bytes] of assets) {
    total += bytes.byteLength;
    if (total > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillPathError(`Skill Bundle exceeds ${MAX_SKILL_BUNDLE_BYTES} byte limit`);
    }
  }
}

export function replaceFrontmatterName(rawMd: string, newName: string): string {
  const match = rawMd.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) throw new Error('SKILL.md frontmatter is missing');
  const frontmatter = match[2]!;
  if (!/^name\s*:/m.test(frontmatter)) throw new Error('SKILL.md frontmatter name is missing');
  const replaced = frontmatter.replace(/^name\s*:.*$/m, `name: ${JSON.stringify(newName)}`);
  return `${match[1]}${replaced}${match[3]}${rawMd.slice(match[0].length)}`;
}

async function collectAssets(
  rootPath: string,
  currentPath: string,
  assets: Record<string, Uint8Array>,
  budget: { files: number; bytes: number },
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (samePath(currentPath, rootPath) && entry.name.toLowerCase() === SKILL_FILE.toLowerCase()) continue;
    const fullPath = join(currentPath, entry.name);
    if (entry.isSymbolicLink()) throw new SkillPathError(`Skill assets cannot contain symlinks: ${fullPath}`);
    if (entry.isDirectory()) {
      await collectAssets(rootPath, fullPath, assets, budget);
      continue;
    }
    if (!entry.isFile()) throw new SkillPathError(`Skill assets must be regular files: ${fullPath}`);

    const relativePath = relative(rootPath, fullPath).split(sep).join('/');
    const fileStat = await stat(fullPath);
    budget.files += 1;
    budget.bytes += fileStat.size;
    if (budget.files > MAX_SKILL_BUNDLE_FILES || budget.bytes > MAX_SKILL_BUNDLE_BYTES) {
      throw new SkillPathError(`Skill assets exceed Bundle limit at: ${relativePath}`);
    }
    assets[relativePath] = new Uint8Array(await readFile(fullPath));
  }
}

async function writeDurableFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}
