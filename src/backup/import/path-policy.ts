import path from 'node:path';
import { SessionImportError } from './errors.js';

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** ZIP 内 ID 最终会参与文件名，必须同时满足 Windows/Linux/macOS。 */
export function assertPortableImportId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !PORTABLE_ID.test(value) || value === '.' || value === '..') {
    throw new SessionImportError('invalid_format', `${label} 不是合法的可移植 ID`);
  }
}

/** 使用 path.relative 证明目标仍在 root 内，兼容 Windows 盘符与大小写规则。 */
export function resolvePathInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new SessionImportError('unsafe_archive_path', '备份内容尝试写出 EmaAgent 数据目录');
  }
  return resolvedPath;
}

/** ZIP 使用 POSIX 分隔符；拒绝绝对路径、盘符、空段和上级目录。 */
export function normalizeArchiveEntryName(name: string): string {
  if (
    !name
    || name.length > 512
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
    || /^[A-Za-z]:/.test(name)
  ) {
    throw new SessionImportError('unsafe_archive_path', `ZIP 条目路径不安全: ${name}`);
  }
  const isDirectory = name.endsWith('/');
  const parts = name.split('/');
  const contentParts = isDirectory ? parts.slice(0, -1) : parts;
  if (contentParts.some((part) => !part || part === '.' || part === '..')) {
    throw new SessionImportError('unsafe_archive_path', `ZIP 条目路径不安全: ${name}`);
  }
  return `${contentParts.join('/')}${isDirectory ? '/' : ''}`;
}
