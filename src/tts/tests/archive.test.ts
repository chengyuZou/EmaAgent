// 测试 TTS 分段音频写盘以及 PCM、WAV、Opus 的安全合并语义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsAudioArchive } from '../archive.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createArchive(): { archive: FsAudioArchive; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tts-archive-'));
  roots.push(root);
  return { archive: new FsAudioArchive(root), root };
}

function wav(pcm: number[], sampleRate = 16_000): Buffer {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('FsAudioArchive', () => {
  it('流式合并 PCM，保留全部分段', async () => {
    const { archive } = createArchive();
    const first = archive.openSegment('s', 't', 0, 'pcm');
    first.write(new Uint8Array([1, 2]));
    first.close();
    const second = archive.openSegment('s', 't', 1, 'pcm');
    second.write(new Uint8Array([3, 4]));
    second.close();

    const result = await archive.finalizeTurn('s', 't', 'pcm');
    expect(result?.byteSize).toBe(4);
    expect(fs.readFileSync(result!.path)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('重写 WAV 容器头并合并全部 PCM data', async () => {
    const { archive } = createArchive();
    const first = archive.openSegment('s', 't', 0, 'wav');
    first.write(wav([1, 2]));
    first.close();
    const second = archive.openSegment('s', 't', 1, 'wav');
    second.write(wav([3, 4]));
    second.close();

    const result = await archive.finalizeTurn('s', 't', 'wav');
    const merged = fs.readFileSync(result!.path);
    expect(merged.readUInt32LE(40)).toBe(4);
    expect([...merged.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it('不把不可安全拼接的多段 Opus 伪装成 merged 文件', async () => {
    const { archive } = createArchive();
    for (let index = 0; index < 2; index++) {
      const writer = archive.openSegment('s', 't', index, 'opus');
      writer.write(new Uint8Array([index]));
      writer.close();
    }

    await expect(archive.finalizeTurn('s', 't', 'opus')).resolves.toBeNull();
    expect(archive.findMergedFor('s', 't')).toBeNull();
  });
});
