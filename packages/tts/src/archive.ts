// 把 TTS 分段音频存到磁盘，并在对话轮结束时按格式拼成整段（mp3/pcm/wav 可拼，ogg 不拼）。

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { mimeFromExt } from './utils.js';

export interface FinalizedAudio {
  path: string;
  mime: string;
  byteSize: number;
  durationMs: number | null;
  segmentCount: number;
}

export interface AudioArchive {
  openSegment(sessionId: string, turnId: string, sentenceIndex: number, ext: string): SegmentWriter;
  finalizeTurn(sessionId: string, turnId: string, ext: string): Promise<FinalizedAudio | null>;
  discardTurn(sessionId: string, turnId: string): void;
  findMergedFor(sessionId: string, turnId: string): { path: string; mime: string } | null;
}

export interface SegmentWriter {
  write(bytes: Uint8Array): void;
  close(): string;
}

interface ByteRange {
  start: number;
  end: number;
}

interface WavInfo extends ByteRange {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

/**
 * 文件系统音频归档。所有路径均由 node:path 生成，可用于 Windows、Linux 与 macOS。
 * 多段合并采用流式复制，内存占用与整个 Turn 的音频体积无关。
 */
export class FsAudioArchive implements AudioArchive {
  constructor(private readonly sessionsRoot: string) {}

  private audioDir(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'audio');
  }

  openSegment(sessionId: string, turnId: string, sentenceIndex: number, ext: string): SegmentWriter {
    const dir = path.join(this.audioDir(sessionId), 'segments', turnId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sentenceIndex}.${ext}`);
    const fd = fs.openSync(filePath, 'w');
    let closed = false;

    return {
      write(bytes): void {
        if (closed) throw new Error('TTS segment writer is already closed');
        fs.writeSync(fd, bytes);
      },
      close(): string {
        if (!closed) {
          fs.closeSync(fd);
          closed = true;
        }
        return filePath;
      },
    };
  }

  async finalizeTurn(sessionId: string, turnId: string, ext: string): Promise<FinalizedAudio | null> {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (!fs.existsSync(segDir)) return null;

    const segments = fs.readdirSync(segDir)
      .filter((file) => file.endsWith(`.${ext}`))
      .sort(byNumericPrefix)
      .map((file) => path.join(segDir, file));
    if (segments.length === 0) return null;

    const mergedDir = path.join(audioDir, 'merged');
    fs.mkdirSync(mergedDir, { recursive: true });
    const target = path.join(mergedDir, `${turnId}.${ext}`);
    const temporary = path.join(mergedDir, `.${turnId}.${process.pid}.${Date.now()}.tmp`);

    let durationMs: number | null = null;
    try {
      if (segments.length === 1) {
        await fs.promises.copyFile(segments[0]!, temporary);
        if (ext === 'wav') {
          const info = await readWavInfo(segments[0]!);
          durationMs = info.byteRate > 0
            ? Math.round(((info.end - info.start + 1) / info.byteRate) * 1000)
            : null;
        }
      } else if (ext === 'mp3') {
        const ranges = await Promise.all(segments.map(readMp3PayloadRange));
        await streamRanges(segments, ranges, temporary);
      } else if (ext === 'pcm') {
        const ranges = await Promise.all(segments.map(fullFileRange));
        await streamRanges(segments, ranges, temporary);
      } else if (ext === 'wav') {
        const infos = await Promise.all(segments.map(readWavInfo));
        assertCompatibleWav(infos);
        const dataBytes = infos.reduce((sum, info) => sum + info.end - info.start + 1, 0);
        await streamWav(segments, infos, temporary, dataBytes);
        durationMs = infos[0]!.byteRate > 0
          ? Math.round((dataBytes / infos[0]!.byteRate) * 1000)
          : null;
      } else {
        // Ogg/Opus 等容器不能用字节拼接伪装成一个合法文件；保留分段并明确不产出 merged。
        return null;
      }

      await replaceFile(temporary, target);
      const stat = await fs.promises.stat(target);
      return {
        path: target,
        mime: mimeFromExt(ext),
        byteSize: stat.size,
        durationMs,
        segmentCount: segments.length,
      };
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  discardTurn(sessionId: string, turnId: string): void {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (fs.existsSync(segDir)) fs.rmSync(segDir, { recursive: true, force: true });
    const merged = path.join(audioDir, 'merged');
    if (!fs.existsSync(merged)) return;
    for (const file of fs.readdirSync(merged)) {
      if (file.startsWith(`${turnId}.`) || file.startsWith(`.${turnId}.`)) {
        fs.rmSync(path.join(merged, file), { force: true });
      }
    }
  }

  findMergedFor(sessionId: string, turnId: string): { path: string; mime: string } | null {
    const dir = path.join(this.audioDir(sessionId), 'merged');
    if (!fs.existsSync(dir)) return null;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(`${turnId}.`)) continue;
      const ext = path.extname(file).slice(1).toLowerCase();
      return { path: path.join(dir, file), mime: mimeFromExt(ext) };
    }
    return null;
  }
}

async function streamRanges(files: string[], ranges: ByteRange[], target: string): Promise<void> {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  try {
    for (let index = 0; index < files.length; index++) {
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

async function streamWav(
  files: string[],
  infos: WavInfo[],
  target: string,
  dataBytes: number,
): Promise<void> {
  if (dataBytes > 0xffff_ffff) throw new Error('WAV merge exceeds the RIFF 4GiB limit');
  const first = infos[0]!;
  const output = fs.createWriteStream(target, { flags: 'wx' });
  output.write(makeWavHeader(first, dataBytes));
  try {
    for (let index = 0; index < files.length; index++) {
      const info = infos[index]!;
      for await (const chunk of fs.createReadStream(files[index]!, info)) {
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

async function fullFileRange(file: string): Promise<ByteRange> {
  const stat = await fs.promises.stat(file);
  return { start: 0, end: stat.size - 1 };
}

async function readMp3PayloadRange(file: string): Promise<ByteRange> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    let start = 0;
    let end = stat.size - 1;
    const header = Buffer.alloc(Math.min(10, stat.size));
    await handle.read(header, 0, header.length, 0);
    if (header.length === 10 && header.subarray(0, 3).toString('ascii') === 'ID3') {
      const tagSize = ((header[6]! & 0x7f) << 21)
        | ((header[7]! & 0x7f) << 14)
        | ((header[8]! & 0x7f) << 7)
        | (header[9]! & 0x7f);
      start = 10 + tagSize + ((header[5]! & 0x10) !== 0 ? 10 : 0);
    }
    if (stat.size >= 128) {
      const trailer = Buffer.alloc(3);
      await handle.read(trailer, 0, 3, stat.size - 128);
      if (trailer.toString('ascii') === 'TAG') end -= 128;
    }
    return { start, end };
  } finally {
    await handle.close();
  }
}

async function readWavInfo(file: string): Promise<WavInfo> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    await handle.read(header, 0, header.length, 0);
    if (header.length < 44 || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`Invalid WAV segment: ${file}`);
    }
    let offset = 12;
    let format: Omit<WavInfo, 'start' | 'end'> | undefined;
    while (offset + 8 <= header.length) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && size >= 16 && body + 16 <= header.length) {
        format = {
          audioFormat: header.readUInt16LE(body),
          channels: header.readUInt16LE(body + 2),
          sampleRate: header.readUInt32LE(body + 4),
          byteRate: header.readUInt32LE(body + 8),
          blockAlign: header.readUInt16LE(body + 12),
          bitsPerSample: header.readUInt16LE(body + 14),
        };
      }
      if (id === 'data') {
        if (!format) throw new Error(`WAV data chunk precedes fmt chunk: ${file}`);
        const end = Math.min(stat.size, body + size) - 1;
        return { ...format, start: body, end };
      }
      offset = body + size + (size % 2);
    }
    throw new Error(`WAV segment has no readable data chunk: ${file}`);
  } finally {
    await handle.close();
  }
}

function assertCompatibleWav(infos: WavInfo[]): void {
  const first = infos[0]!;
  for (const info of infos.slice(1)) {
    if (info.audioFormat !== first.audioFormat
      || info.channels !== first.channels
      || info.sampleRate !== first.sampleRate
      || info.bitsPerSample !== first.bitsPerSample
      || info.blockAlign !== first.blockAlign) {
      throw new Error('Cannot merge WAV segments with different audio formats');
    }
  }
}

function makeWavHeader(info: WavInfo, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(info.audioFormat, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.byteRate, 28);
  header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    // Windows 不允许 rename 覆盖已有目标；仅在平台拒绝覆盖时处理当前 Turn 的旧文件。
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(temporary, target);
  }
}

function byNumericPrefix(a: string, b: string): number {
  const left = Number.parseInt(a, 10);
  const right = Number.parseInt(b, 10);
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return a.localeCompare(b);
}
