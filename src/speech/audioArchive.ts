import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

export interface FinalizedAudio {
  readonly path: string;
  readonly mime: 'audio/mpeg';
  readonly byteSize: number;
  readonly durationMs: null;
  readonly segmentCount: number;
}

export interface SegmentWriter {
  write(bytes: Uint8Array): void;
  close(): void;
  discard(): void;
}

export interface AudioArchive {
  openSegment(sessionId: string, turnId: string, sentenceIndex: number): SegmentWriter;
  finalizeTurn(sessionId: string, turnId: string): Promise<FinalizedAudio | null>;
  discardTurn(sessionId: string, turnId: string): void;
  findMergedFor(sessionId: string, turnId: string): { path: string; mime: 'audio/mpeg' } | null;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** V1 的 TTS 输出固定为 MP3。逐句文件只服务实时合并，成功合并或取消后立即删除。 */
export class FsAudioArchive implements AudioArchive {
  constructor(private readonly sessionsRoot: string) {}

  openSegment(sessionId: string, turnId: string, sentenceIndex: number): SegmentWriter {
    const directory = this.segmentDirectory(sessionId, turnId);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `${sentenceIndex}.mp3`);
    const descriptor = fs.openSync(filePath, 'w');
    let closed = false;

    return {
      write(bytes) {
        if (closed) throw new Error('TTS segment writer is already closed');
        fs.writeSync(descriptor, bytes);
      },
      close() {
        if (closed) return;
        fs.closeSync(descriptor);
        closed = true;
      },
      discard() {
        if (!closed) {
          fs.closeSync(descriptor);
          closed = true;
        }
        fs.rmSync(filePath, { force: true });
      },
    };
  }

  async finalizeTurn(sessionId: string, turnId: string): Promise<FinalizedAudio | null> {
    const segmentDirectory = this.segmentDirectory(sessionId, turnId);
    if (!fs.existsSync(segmentDirectory)) return null;
    const segments = fs.readdirSync(segmentDirectory)
      .filter(file => file.endsWith('.mp3'))
      .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
      .map(file => path.join(segmentDirectory, file));
    if (segments.length === 0) {
      fs.rmSync(segmentDirectory, { recursive: true, force: true });
      return null;
    }

    const mergedDirectory = path.join(this.audioDirectory(sessionId), 'merged');
    fs.mkdirSync(mergedDirectory, { recursive: true });
    const target = path.join(mergedDirectory, `${turnId}.mp3`);
    const temporary = path.join(mergedDirectory, `.${turnId}.${process.pid}.tmp`);
    try {
      const ranges = await Promise.all(segments.map(readMp3PayloadRange));
      await streamRanges(segments, ranges, temporary);
      await replaceFile(temporary, target);
      const byteSize = (await fs.promises.stat(target)).size;
      await fs.promises.rm(segmentDirectory, { recursive: true, force: true });
      return {
        path: target,
        mime: 'audio/mpeg',
        byteSize,
        durationMs: null,
        segmentCount: segments.length,
      };
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  discardTurn(sessionId: string, turnId: string): void {
    fs.rmSync(this.segmentDirectory(sessionId, turnId), { recursive: true, force: true });
    const mergedDirectory = path.join(this.audioDirectory(sessionId), 'merged');
    fs.rmSync(path.join(mergedDirectory, `${turnId}.mp3`), { force: true });
    fs.rmSync(path.join(mergedDirectory, `.${turnId}.${process.pid}.tmp`), { force: true });
  }

  findMergedFor(sessionId: string, turnId: string): { path: string; mime: 'audio/mpeg' } | null {
    const filePath = path.join(this.audioDirectory(sessionId), 'merged', `${turnId}.mp3`);
    return fs.existsSync(filePath) ? { path: filePath, mime: 'audio/mpeg' } : null;
  }

  private audioDirectory(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'audio');
  }

  private segmentDirectory(sessionId: string, turnId: string): string {
    return path.join(this.audioDirectory(sessionId), 'segments', turnId);
  }
}

async function streamRanges(files: readonly string[], ranges: readonly ByteRange[], target: string): Promise<void> {
  const output = fs.createWriteStream(target, { flags: 'w' });
  try {
    for (let index = 0; index < files.length; index += 1) {
      const range = ranges[index]!;
      if (range.end < range.start) continue;
      for await (const chunk of fs.createReadStream(files[index]!, range)) {
        if (!output.write(chunk)) await once(output, 'drain');
      }
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
}

/** MP3 各段可能各带一份 ID3 标签，合并时只拼音频帧。 */
async function readMp3PayloadRange(file: string): Promise<ByteRange> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    let start = 0;
    let end = size - 1;
    const header = Buffer.alloc(Math.min(10, size));
    await handle.read(header, 0, header.length, 0);
    if (header.length === 10 && header.subarray(0, 3).toString('ascii') === 'ID3') {
      const tagSize = ((header[6]! & 0x7f) << 21)
        | ((header[7]! & 0x7f) << 14)
        | ((header[8]! & 0x7f) << 7)
        | (header[9]! & 0x7f);
      start = 10 + tagSize + ((header[5]! & 0x10) !== 0 ? 10 : 0);
    }
    if (size >= 128) {
      const trailer = Buffer.alloc(3);
      await handle.read(trailer, 0, 3, size - 128);
      if (trailer.toString('ascii') === 'TAG') end -= 128;
    }
    return { start, end };
  } finally {
    await handle.close();
  }
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(temporary, target);
  }
}
