import path from 'node:path';
import { SessionImportError } from '../errors.js';

export function normalizeArchivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0')
  ) {
    throw new SessionImportError('unsafe_archive_path', `ZIP 路径不安全: ${value}`);
  }
  const parts = normalized.replace(/\/$/, '').split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new SessionImportError('unsafe_archive_path', `ZIP 路径不安全: ${value}`);
  }
  return normalized;
}

export function resolveInside(root: string, entryPath: string): string {
  const destination = path.resolve(root, ...entryPath.split('/'));
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SessionImportError('unsafe_archive_path', `ZIP 路径越出临时目录: ${entryPath}`);
  }
  return destination;
}
