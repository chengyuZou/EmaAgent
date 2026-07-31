// 校验 ZIP 完整性清单覆盖全部条目，并逐文件核对未压缩大小与 SHA-256。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  BACKUP_INTEGRITY_PATH,
} from '../records/recordRegistry.js';
import type { BackupIntegrityManifest, IntegrityEntry } from '../export/sessionExport.js';
import { SessionImportError } from './errors.js';
import type { ExtractedSessionArchive } from './archive.js';

export async function verifyArchiveIntegrity(
  archive: ExtractedSessionArchive,
  signal?: AbortSignal,
): Promise<void> {
  const manifestEntry = archive.require(BACKUP_INTEGRITY_PATH);
  let manifest: BackupIntegrityManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestEntry.filePath, 'utf8')) as BackupIntegrityManifest;
  } catch {
    throw new SessionImportError('integrity_mismatch', '完整性清单不是合法 JSON');
  }
  if (manifest.algorithm !== 'sha256' || !Array.isArray(manifest.entries)) {
    throw new SessionImportError('integrity_mismatch', '完整性清单格式非法');
  }

  const expected = new Map<string, IntegrityEntry>();
  for (const item of manifest.entries) {
    if (!isIntegrityEntry(item) || item.path === BACKUP_INTEGRITY_PATH || expected.has(item.path)) {
      throw new SessionImportError('integrity_mismatch', '完整性清单包含非法或重复条目');
    }
    expected.set(item.path, item);
  }
  const actualPaths = archive.paths().filter(path => path !== BACKUP_INTEGRITY_PATH);
  if (
    actualPaths.length !== expected.size
    || actualPaths.some(path => !expected.has(path))
  ) {
    throw new SessionImportError('integrity_mismatch', '完整性清单没有精确覆盖 ZIP 条目');
  }

  for (const entryPath of actualPaths) {
    if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
    const entry = archive.require(entryPath);
    const declared = expected.get(entryPath)!;
    if (declared.size !== entry.size) {
      throw new SessionImportError('integrity_mismatch', `条目大小校验失败: ${entryPath}`);
    }
    const digest = await sha256File(entry.filePath, signal);
    if (digest !== declared.sha256) {
      throw new SessionImportError('integrity_mismatch', `条目摘要校验失败: ${entryPath}`);
    }
  }
}

function isIntegrityEntry(value: unknown): value is IntegrityEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<IntegrityEntry>;
  return typeof entry.path === 'string'
    && /^[a-f0-9]{64}$/.test(entry.sha256 ?? '')
    && Number.isSafeInteger(entry.size)
    && (entry.size ?? -1) >= 0;
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
