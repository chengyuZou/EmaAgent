// Skill 路径安全:市场下载文件的相对路径校验、root 内普通目录/文件约束。
// 全部为纯函数,供 user 域对账与 market 安装共用。
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { posix, win32, resolve, dirname } from 'node:path';
import { SkillPathError } from './errors.js';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MAX_RELATIVE_PATH_LENGTH = 240;
const SKILL_FILE = 'SKILL.md';
/** 内部条目(staging、事务残留等)的目录名前缀,扫描时跳过。 */
const INTERNAL_ENTRY_PREFIX = '.ema-skill-';

/** 下载文件必须是可安全落盘的 POSIX 相对路径:无 .. / 无绝对形态 / 跨平台合法。 */
export function assertPortableRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new SkillPathError(`技能文件路径为空或过长: ${relativePath}`);
  }
  if (relativePath.includes('\\') || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new SkillPathError(`技能文件路径必须使用安全的 POSIX 相对路径: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new SkillPathError(`技能文件路径包含越界或空片段: ${relativePath}`);
  }
  for (const segment of segments) {
    if (WINDOWS_FORBIDDEN_CHARS.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) {
      throw new SkillPathError(`技能文件路径无法跨平台安全落盘: ${relativePath}`);
    }
  }
}

/** 平台感知的路径相等(Windows 大小写折叠)。 */
export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, '');
  const normalizedRight = resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** 必须是普通文件(拒绝符号链接/目录/设备)。 */
export async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SkillPathError(`Skill file must be a regular file: ${filePath}`);
  }
}

/** 解析 root 内任意深度的相对路径文件:POSIX 相对形态 + realpath 后不逃出 root。 */
export async function resolveFileInside(rootDir: string, relativePath: string): Promise<string> {
  assertPortableRelativePath(relativePath);
  const target = resolve(rootDir, relativePath);
  await assertRegularFile(target);
  const canonicalTarget = await realpath(target);
  const canonicalRoot = await realpath(rootDir);
  if (!canonicalTarget.startsWith(canonicalRoot + '/') && !canonicalTarget.startsWith(canonicalRoot + '\\')) {
    throw new SkillPathError(`Skill file escapes its directory: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

/** 列出 root 下的技能目录(普通目录,跳过 .ema-skill- 内部条目)。 */
export async function listSkillDirectories(rootPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(INTERNAL_ENTRY_PREFIX))
    .map(entry => joinPaths(rootPath, entry.name));
}

/**
 * 把 targetPath 约束为 root 下的直接普通目录:拒绝符号链接,
 * realpath 后的父目录必须就是 root(防 Junction/软链逃逸)。
 */
export async function resolveChildDirectory(rootPath: string, targetPath: string): Promise<string> {
  const canonicalRoot = await realpath(await mkdirp(rootPath));
  const targetStat = await lstat(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new SkillPathError(`Skill directory must be a regular directory: ${targetPath}`);
  }
  const canonicalTarget = await realpath(targetPath);
  if (!samePath(dirname(canonicalTarget), canonicalRoot)) {
    throw new SkillPathError(`Skill directory escapes configured root: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

/** 技能目录下 SKILL.md 的受约束解析:普通文件且不逃出目录。 */
export async function resolveSkillFile(skillDir: string): Promise<string> {
  const file = joinPaths(skillDir, SKILL_FILE);
  await assertRegularFile(file);
  const canonicalFile = await realpath(file);
  if (!samePath(dirname(canonicalFile), skillDir)) {
    throw new SkillPathError(`Skill file escapes its directory: ${canonicalFile}`);
  }
  return canonicalFile;
}

async function mkdirp(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

function joinPaths(root: string, child: string): string {
  return resolve(root, child);
}
