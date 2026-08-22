// 验证 ZIP 流式解压接受现行路径并拒绝归档白名单之外的条目。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSessionArchive } from '../import/archive.js';
import type { BackupArchiveSource } from '../types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('archive', () => {
  it('把允许的条目解压到临时目录', async () => {
    const bytes = zipSync({ 'manifest.json': new TextEncoder().encode('{}') });
    const archive = await extractSessionArchive(source(bytes), temporaryRoot());
    expect(fs.readFileSync(archive.require('manifest.json').filePath, 'utf8')).toBe('{}');
    archive.dispose();
  });

  it('拒绝未知条目', async () => {
    const bytes = zipSync({ 'unknown.txt': new Uint8Array([1]) });
    await expect(extractSessionArchive(source(bytes), temporaryRoot()))
      .rejects.toMatchObject({ code: 'invalid_format' });
  });
});

function source(bytes: Uint8Array): BackupArchiveSource {
  return {
    declaredBytes: bytes.byteLength,
    async *chunks() { yield bytes; },
  };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-archive-'));
  roots.push(root);
  return root;
}
