// 测试立绘与参考音频的原字节保留、稳定文件名和主用项提升。

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import { CharacterStore } from '../store.js';

describe('character illustration and voice files', () => {
  let database: Database;
  let root: string;
  let store: CharacterStore;
  let characterId: string;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    root = fs.mkdtempSync(path.join(tmpdir(), 'ema-character-media-'));
    store = new CharacterStore(database, path.join(root, 'characters'));
    store.ensureSeed();
    characterId = store.create({
      name: 'Alice',
      personaPrompt: 'Alice prompt',
    }).id;
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('立绘按源文件名保留原字节，修改显示名不移动文件', async () => {
    const bytes = pngBytes();
    const source = path.join(root, 'portrait.png');
    fs.writeFileSync(source, bytes);
    const imported = await store.importIllustration(characterId, { sourceFile: source });
    const physicalFile = store.resolveIllustrationFile(characterId, imported.id);

    expect(imported).toMatchObject({ name: 'portrait', fileName: 'portrait.png' });
    expect(physicalFile).toBe(path.join(
      root,
      'characters',
      'Alice',
      'illustration',
      'portrait.png',
    ));
    expect(fs.readFileSync(physicalFile)).toEqual(bytes);

    store.updateIllustration(characterId, imported.id, { name: '新立绘' });
    expect(store.resolveIllustrationFile(characterId, imported.id)).toBe(physicalFile);
    const exportDirectory = path.join(root, 'illustration-export');
    fs.mkdirSync(exportDirectory);
    const exported = await store.exportIllustration(characterId, imported.id, exportDirectory);
    expect(exported).toBe(path.join(exportDirectory, '新立绘.png'));
    expect(fs.readFileSync(exported)).toEqual(bytes);
  });

  it('停用主立绘后提升最早创建的其他启用立绘', async () => {
    const firstSource = path.join(root, 'first.png');
    const secondSource = path.join(root, 'second.png');
    fs.writeFileSync(firstSource, pngBytes());
    fs.writeFileSync(secondSource, pngBytes());
    const first = await store.importIllustration(characterId, { sourceFile: firstSource });
    const second = await store.importIllustration(characterId, { sourceFile: secondSource });

    store.updateIllustration(characterId, first.id, { enabled: false });
    const resources = store.listIllustrations(characterId);
    expect(resources.find((resource) => resource.id === first.id)?.isPrimary).toBe(false);
    expect(resources.find((resource) => resource.id === second.id)?.isPrimary).toBe(true);
  });

  it('参考音频按源文件名保留原字节并使用 voice 目录', async () => {
    const bytes = wavBytes();
    const source = path.join(root, 'sample.wav');
    fs.writeFileSync(source, bytes);
    const imported = await store.importVoiceSample(characterId, {
      sourceFile: source,
      promptText: 'sample text',
      promptLang: 'zh',
    });
    const physicalFile = store.resolveVoiceSampleFile(characterId, imported.id);

    expect(imported).toMatchObject({ name: 'sample', fileName: 'sample.wav' });
    expect(physicalFile).toBe(path.join(
      root,
      'characters',
      'Alice',
      'voice',
      'sample.wav',
    ));
    expect(fs.readFileSync(physicalFile)).toEqual(bytes);

    store.updateVoiceSample(characterId, imported.id, { name: '新参考音' });
    expect(store.resolveVoiceSampleFile(characterId, imported.id)).toBe(physicalFile);
    const exportDirectory = path.join(root, 'voice-export');
    fs.mkdirSync(exportDirectory);
    const exported = await store.exportVoiceSample(characterId, imported.id, exportDirectory);
    expect(exported).toBe(path.join(exportDirectory, '新参考音.wav'));
    expect(fs.readFileSync(exported)).toEqual(bytes);
  });

  it('立绘文件已不存在时仍可删除 SQL 记录', async () => {
    const source = path.join(root, 'missing.png');
    fs.writeFileSync(source, pngBytes());
    const imported = await store.importIllustration(characterId, { sourceFile: source });
    fs.rmSync(store.resolveIllustrationFile(characterId, imported.id));

    await expect(store.deleteIllustration(characterId, imported.id)).resolves.toMatchObject({
      id: imported.id,
    });
    expect(store.listIllustrations(characterId)).toEqual([]);
  });
});

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

function wavBytes(): Buffer {
  const samples = 8_000;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(8_000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  return buffer;
}
