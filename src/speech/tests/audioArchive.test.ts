// 验证逐句 MP3 只在合并期间存在，成功或单句失败后都不留下临时片段。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsAudioArchive } from '../audioArchive.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createArchive(): { archive: FsAudioArchive; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ema-tts-archive-'));
  roots.push(root);
  return { archive: new FsAudioArchive(root), root };
}

describe('FsAudioArchive', () => {
  it('按句序合并 MP3 并删除临时片段', async () => {
    const { archive, root } = createArchive();
    const first = archive.openSegment('s', 't', 0);
    first.write(new Uint8Array([1, 2]));
    first.close();
    const second = archive.openSegment('s', 't', 1);
    second.write(new Uint8Array([3, 4]));
    second.close();

    const result = await archive.finalizeTurn('s', 't');
    expect(fs.readFileSync(result!.path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(fs.existsSync(path.join(root, 's', 'audio', 'segments', 't'))).toBe(false);
  });

  it('失败的句子立即删除临时文件', () => {
    const { archive, root } = createArchive();
    const writer = archive.openSegment('s', 't', 0);
    writer.write(new Uint8Array([1, 2, 3]));
    writer.discard();
    expect(fs.existsSync(path.join(root, 's', 'audio', 'segments', 't', '0.mp3'))).toBe(false);
  });
});
