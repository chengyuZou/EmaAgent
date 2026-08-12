// 测试附件登记：Server 权威化、限额、受管副本落盘、单事务与源状态检查。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import {
  AttachmentRepo,
  Database,
} from '@ema-agent/storage';
import { AttachmentStore } from '../attachmentStore.js';
import { AttachmentLimitError, AttachmentPreparationError } from '../errors.js';

const sessionId = asSessionId('session-att');
const turnId = asTurnId('turn-att');

const temporary: string[] = [];
let database: Database;
let dataDir: string;
let store: AttachmentStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ema-att-store-'));
  temporary.push(dataDir);
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES (?, 's', 0, 1, 1, 1)
  `).run(sessionId);
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
      status, user_input, started_at)
    VALUES (?, ?, 'userMessage', 'chat', 'off', 'completed', '', 1)
  `).run(turnId, sessionId);
  store = new AttachmentStore({ repo: new AttachmentRepo(database.sqlite), dataDir });
});

afterEach(() => {
  database.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSource(name: string, content: string | Buffer): string {
  const file = path.join(dataDir, name);
  writeFileSync(file, content);
  return file;
}

describe('AttachmentStore.addAll', () => {
  it('file 只记路径；image 原始字节复制进 Session 受管目录', async () => {
    const file = writeSource('notes.txt', 'hello');
    const image = writeSource('photo.png', Buffer.from([1, 2, 3, 4]));

    const result = await store.addAll([
      { sourcePath: file },
      { sourcePath: image },
    ], turnId, sessionId);

    expect(result).toHaveLength(2);
    const [fileAtt, imageAtt] = result;
    expect(fileAtt!.kind).toBe('file');
    expect(fileAtt!.name).toBe('notes.txt');
    expect(imageAtt!.kind).toBe('image');
    if (imageAtt!.kind !== 'image') throw new Error('unreachable');

    const expectedCopy = path.join(
      dataDir, 'sessions', sessionId, 'attachments', `${imageAtt!.id}.png`,
    );
    expect(imageAtt!.imagePath).toBe(expectedCopy);
    expect(await readFile(expectedCopy)).toEqual(Buffer.from([1, 2, 3, 4]));

    // 数据库行与返回值一致（单事务写入后可查）
    expect(store.listByTurn(turnId)).toHaveLength(2);
  });

  it('wire 上的展示性字段不覆盖 realpath/stat 权威值', async () => {
    const file = writeSource('real.txt', 'real content');
    const [att] = await store.addAll([{
      sourcePath: file,
      name: 'fake.png',
      mimeType: 'image/png',
      size: 999_999,
      mtime: 1,
    }], turnId, sessionId);

    expect(att!.name).toBe('real.txt');
    expect(att!.kind).toBe('file');
    expect(att!.mimeType).toBe('text/plain');
  });

  it('图片数量、单图字节、文件数量超限时整批拒绝且不写库', async () => {
    const small = writeSource('a.png', Buffer.alloc(4));
    await expect(store.addAll(
      [{ sourcePath: small }, { sourcePath: small }],
      turnId, sessionId,
      { maxImagesPerTurn: 1, maxFilesPerTurn: 10, maxImageBytes: 1024 },
    )).rejects.toThrow(AttachmentLimitError);

    await expect(store.addAll(
      [{ sourcePath: writeSource('big.png', Buffer.alloc(2048)) }],
      turnId, sessionId,
      { maxImagesPerTurn: 10, maxFilesPerTurn: 10, maxImageBytes: 1024 },
    )).rejects.toThrow(AttachmentLimitError);

    expect(store.listByTurn(turnId)).toHaveLength(0);
    // 限额在落盘前拒绝，受管目录不应有残留
    const managed = path.join(dataDir, 'sessions', sessionId, 'attachments');
    await expect(stat(managed)).rejects.toThrow();
  });

  it('路径不存在或不是普通文件时抛 AttachmentPreparationError', async () => {
    await expect(store.addAll(
      [{ sourcePath: path.join(dataDir, 'nope.txt') }],
      turnId, sessionId,
    )).rejects.toThrow(AttachmentPreparationError);

    await expect(store.addAll(
      [{ sourcePath: dataDir }],
      turnId, sessionId,
    )).rejects.toThrow(AttachmentPreparationError);
  });

  it('SQL 写库失败时删除本批已发布副本，不留半成品', async () => {
    const image = writeSource('orphan.png', Buffer.alloc(4));
    // 无父 Turn 的 turnId 会触发归属/外键约束，insertMany 必然失败。
    await expect(store.addAll(
      [{ sourcePath: image }],
      asTurnId('turn-nonexistent'), sessionId,
    )).rejects.toThrow(AttachmentPreparationError);

    const managed = path.join(dataDir, 'sessions', sessionId, 'attachments');
    const leftovers = await readdir(managed).catch(() => ['<dir-missing>']);
    expect(leftovers.filter((name) => !name.startsWith('.'))).toEqual([]);
  });
});

describe('AttachmentStore.inspectBySession / getMany', () => {
  it('区分 available / modified / missing', async () => {
    const stable = writeSource('stable.txt', 'aaa');
    const changed = writeSource('changed.txt', 'bbb');
    const gone = writeSource('gone.txt', 'ccc');

    await store.addAll([
      { sourcePath: stable },
      { sourcePath: changed },
      { sourcePath: gone },
    ], turnId, sessionId);

    writeFileSync(changed, 'bbbb-more');
    rmSync(gone);

    const inspected = await store.inspectBySession(sessionId);
    const byName = new Map(inspected.map((item) => [item.name, item.sourceStatus]));
    expect(byName.get('stable.txt')).toBe('available');
    expect(byName.get('changed.txt')).toBe('modified');
    expect(byName.get('gone.txt')).toBe('missing');
  });

  it('getMany 按 id 批量返回并保留判别联合形状', async () => {
    const image = writeSource('pic.png', Buffer.alloc(8));
    const [created] = await store.addAll([{ sourcePath: image }], turnId, sessionId);

    const map = store.getMany([created!.id]);
    const found = map.get(created!.id);
    expect(found?.kind).toBe('image');
    if (found?.kind === 'image') {
      expect(found.imageByteSize).toBe(8);
    }
    expect(map.size).toBe(1);
  });
});
