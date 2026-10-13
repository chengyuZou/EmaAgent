import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSessionArchive } from '../import/archive.js';
import { writeZip } from './zipFixtures.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('archive', () => {
  it('把允许的条目解压到临时目录', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, 'input.zip');
    await writeZip(zipPath, new Map([['manifest.json', '{}']]));
    const archive = await extractSessionArchive(zipPath, path.join(root, 'work'));
    expect(fs.readFileSync(archive.require('manifest.json').filePath, 'utf8')).toBe('{}');
    archive.dispose();
  });

  it('写盘前拒绝越界路径', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, 'input.zip');
    await writeZip(zipPath, new Map([['ok/unknown.txt', '1']]));
    // Archiver 会清理 ../, 因此修改本地头和中央目录中的等长文件名以构造外部坏 ZIP.
    const bytes = fs.readFileSync(zipPath);
    let index = bytes.indexOf('ok/unknown.txt');
    while (index !== -1) {
      bytes.write('../unknown.txt', index, 'utf8');
      index = bytes.indexOf('ok/unknown.txt', index + 1);
    }
    fs.writeFileSync(zipPath, bytes);
    await expect(extractSessionArchive(zipPath, path.join(root, 'work')))
      .rejects.toMatchObject({ code: 'unsafe_archive_path' });
    expect(fs.existsSync(path.join(root, 'unknown.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'work'))).toEqual([]);
  });

  it('拒绝大小写不同的同名文件, 失败后删除解压目录', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, 'input.zip');
    await writeZip(zipPath, new Map([['manifest.json', '{}'], ['MANIFEST.json', '{}']]));
    await expect(extractSessionArchive(zipPath, path.join(root, 'work')))
      .rejects.toMatchObject({ code: 'invalid_format' });
    expect(fs.readdirSync(path.join(root, 'work'))).toEqual([]);
  });

  it('支持 ZIP64 和中文文件名', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, '中文备份.zip');
    await writeZip(zipPath, new Map([['files/语音.wav', '音频内容']]), true);
    const archive = await extractSessionArchive(zipPath, path.join(root, 'work'));
    expect(fs.readFileSync(archive.require('files/语音.wav').filePath, 'utf8')).toBe('音频内容');
    archive.dispose();
  });

  it('损坏 ZIP 返回错误并清理临时文件', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, 'invalid.zip');
    fs.writeFileSync(zipPath, 'not a zip');
    await expect(extractSessionArchive(zipPath, path.join(root, 'work')))
      .rejects.toMatchObject({ code: 'invalid_zip' });
    expect(fs.readdirSync(path.join(root, 'work'))).toEqual([]);
  });

  it('取消导入返回取消原因而不是损坏 ZIP', async () => {
    const root = temporaryRoot();
    const zipPath = path.join(root, 'input.zip');
    const controller = new AbortController();
    controller.abort();
    await expect(extractSessionArchive(zipPath, path.join(root, 'work'), controller.signal))
      .rejects.toMatchObject({ code: 'import_cancelled', status: 499 });
    expect(fs.readdirSync(path.join(root, 'work'))).toEqual([]);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-backup-archive-'));
  roots.push(root);
  return root;
}
