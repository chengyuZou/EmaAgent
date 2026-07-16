// 这里校验 Skill slug 和 Bundle 相对路径在 Windows, Linux 与 macOS 上都安全.
import { posix, resolve, win32 } from 'node:path';
import { SkillPathError } from './errors.js';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MAX_RELATIVE_PATH_LENGTH = 240;

export function skillSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

export function validateSkillAssets(
  assets: Readonly<Record<string, Uint8Array>>,
): Array<readonly [string, Uint8Array]> {
  const normalizedNames = new Set<string>();
  const entries = Object.entries(assets).sort(([left], [right]) => left.localeCompare(right));

  for (const [relativePath] of entries) {
    assertPortableRelativePath(relativePath);
    const portableKey = relativePath.toLowerCase();
    if (normalizedNames.has(portableKey)) {
      throw new SkillPathError(`Skill Bundle 存在跨平台重名路径: ${relativePath}`);
    }
    normalizedNames.add(portableKey);
  }
  return entries;
}

export function assertPortableRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new SkillPathError(`Skill Bundle 路径为空或过长: ${relativePath}`);
  }
  if (relativePath.includes('\\') || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new SkillPathError(`Skill Bundle 路径必须使用安全的 POSIX 相对路径: ${relativePath}`);
  }

  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new SkillPathError(`Skill Bundle 路径包含越界或空片段: ${relativePath}`);
  }
  for (const segment of segments) {
    if (WINDOWS_FORBIDDEN_CHARS.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) {
      throw new SkillPathError(`Skill Bundle 路径无法跨平台安全落盘: ${relativePath}`);
    }
  }
  if (relativePath.toLowerCase() === 'skill.md') {
    throw new SkillPathError('Bundle assets 不能覆盖 SKILL.md');
  }
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, '');
  const normalizedRight = resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
