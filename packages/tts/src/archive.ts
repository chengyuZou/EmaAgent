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
 *
 * 目录布局(sessionsRoot = {dataDir}/sessions):
 *   {sessionsRoot}/{sessionId}/audio/segments/{turnId}/{index}.{ext}   每句一段
 *   {sessionsRoot}/{sessionId}/audio/merged/{turnId}.{ext}              合并后的整段
 *
 * 合并按格式分治:mp3/pcm/wav 可拼(各自逻辑),ogg/opus 不拼(返回 null 保留分段)。
 */
export class FsAudioArchive implements AudioArchive {
  constructor(private readonly sessionsRoot: string) {}

  private audioDir(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'audio');
  }

  /**
   * 开一个分段写句柄。coordinator 每句合成时调一次,边收音频块边写盘。
   * 文件名用 sentenceIndex(0.mp3/1.mp3...),finalizeTurn 按数字前缀排序拼接保句序。
   * 同步 fs:V1 串行合成(并发=1),8KB 块同步写几毫秒,不值得管 async fd 生命周期。
   */
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
        // closed flag 幂等:coordinator 的 finally + 异常路径都可能调 close,防重复关抛 EBADF。
        if (!closed) {
          fs.closeSync(fd);
          closed = true;
        }
        return filePath;
      },
    };
  }

  /**
   * 把一个 turn 的分段音频合并成整段文件,供 GET /api/turns/:turnId/audio 回放。
   *
   * 合并按格式分治(能不能字节拼接取决于容器):
   *   单段  -> 直接 copyFile(无东西可拼)
   *   mp3   -> 剥 ID3v2 头/ID3v1 尾后拼裸帧(帧序列可直接拼接)
   *   pcm   -> 裸数据无容器,直接拼
   *   wav   -> 校验各段格式一致 -> 重写 RIFF 头 + 拼数据(头里 data size 变了必须重写)
   *   ogg/opus -> 容器有页结构,字节拼接破坏页边界 -> 返回 null 保留分段(fail-closed)
   *
   * 原子写:先写 .tmp(pid+Date.now 防并发冲突),成功后 replaceFile 原子替换。
   * 流式复制(createReadStream+createWriteStream+背压),内存与 turn 音频体积无关。
   */
  async finalizeTurn(sessionId: string, turnId: string, ext: string): Promise<FinalizedAudio | null> {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (!fs.existsSync(segDir)) return null;

    // 按数字前缀排序(0.mp3/1.mp3...),保句序 = 播放序
    const segments = fs.readdirSync(segDir)
      .filter((file) => file.endsWith(`.${ext}`))
      .sort(byNumericPrefix)
      .map((file) => path.join(segDir, file));
    if (segments.length === 0) return null;

    const mergedDir = path.join(audioDir, 'merged');
    fs.mkdirSync(mergedDir, { recursive: true });
    const target = path.join(mergedDir, `${turnId}.${ext}`);
    // .tmp 带 pid+Date.now:防同 turn 并发 finalize 冲突(理论不会,防御性)
    const temporary = path.join(mergedDir, `.${turnId}.${process.pid}.${Date.now()}.tmp`);

    let durationMs: number | null = null;
    try {
      if (segments.length === 1) {
        // 单段:直接复制,无东西可拼。wav 单段也要读头算时长。
        await fs.promises.copyFile(segments[0]!, temporary);
        if (ext === 'wav') {
          const info = await readWavInfo(segments[0]!);
          durationMs = info.byteRate > 0
            ? Math.round(((info.end - info.start + 1) / info.byteRate) * 1000)
            : null;
        }
      } else if (ext === 'mp3') {
        // mp3:剥各段 ID3v2 头/ID3v1 尾,只拼音频帧
        const ranges = await Promise.all(segments.map(readMp3PayloadRange));
        await streamRanges(segments, ranges, temporary);
      } else if (ext === 'pcm') {
        // pcm:裸数据无容器,整文件范围直接拼
        const ranges = await Promise.all(segments.map(fullFileRange));
        await streamRanges(segments, ranges, temporary);
      } else if (ext === 'wav') {
        // wav:校验格式一致 -> 算总 data 字节 -> 重写 RIFF 头 + 拼数据
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

  /**
   * 丢弃一个 turn 的所有音频(abort 时调)。幂等:兼容"有 merged""没 merged"
   * "只有分段"各种状态。前缀匹配清 merged 里该 turn 的文件(含 .tmp 残留)。
   */
  discardTurn(sessionId: string, turnId: string): void {
    const audioDir = this.audioDir(sessionId);
    const segDir = path.join(audioDir, 'segments', turnId);
    if (fs.existsSync(segDir)) fs.rmSync(segDir, { recursive: true, force: true });
    const merged = path.join(audioDir, 'merged');
    if (!fs.existsSync(merged)) return;
    // 前缀匹配 turnId. 和 .turnId.(.tmp 残留),防 merged 还没生成时也无害
    for (const file of fs.readdirSync(merged)) {
      if (file.startsWith(`${turnId}.`) || file.startsWith(`.${turnId}.`)) {
        fs.rmSync(path.join(merged, file), { force: true });
      }
    }
  }

  /** 查某 turn 的合并文件(供 HTTP 回放路由用)。无则 null。 */
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

/**
 * 流式复制各段的指定字节范围到 target。内存恒定(几 KB 缓冲),与 turn 音频体积无关。
 * 用于 mp3(剥头尾后的帧范围)和 pcm(整文件范围)。
 */
async function streamRanges(files: string[], ranges: ByteRange[], target: string): Promise<void> {
  const output = fs.createWriteStream(target, { flags: 'wx' });
  try {
    for (let index = 0; index < files.length; index++) {
      const range = ranges[index]!;
      if (range.end < range.start) continue;
      for await (const chunk of fs.createReadStream(files[index]!, range)) {
        // 背压:write 返回 false 表示缓冲满,等 drain 再继续。不处理会内存暴涨。
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

/**
 * 流式合并 wav:先写新 RIFF 头(用第一段格式 + 总 dataBytes),再流式拼接各段 data。
 * 超过 RIFF 4GiB 上限抛错(ChunkSize 是 32 位)。
 */

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

/**
 * 算 mp3 文件的音频帧字节范围(剥 ID3v2 头 + ID3v1 尾)。
 * ID3v2 在文件头(元数据),ID3v1 在文件尾(128 字节旧式标签),都不是音频帧,
 * 拼进流里会让播放器在拼接处乱跳。剥掉只拼音频帧。
 */
async function readMp3PayloadRange(file: string): Promise<ByteRange> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    let start = 0;
    let end = stat.size - 1;
    // 读前 10 字节判 ID3v2:前 3 字节 "ID3",后 4 字节是同步安全大小(每字节只用低 7 位)
    const header = Buffer.alloc(Math.min(10, stat.size));
    await handle.read(header, 0, header.length, 0);
    if (header.length === 10 && header.subarray(0, 3).toString('ascii') === 'ID3') {
      const tagSize = ((header[6]! & 0x7f) << 21)
        | ((header[7]! & 0x7f) << 14)
        | ((header[8]! & 0x7f) << 7)
        | (header[9]! & 0x7f);
      // 10 字节头 + tagSize 数据 + 可选 10 字节 footer(flag 第 4 位置 1 时有)
      start = 10 + tagSize + ((header[5]! & 0x10) !== 0 ? 10 : 0);
    }
    // 读后 128 字节判 ID3v1:前 3 字节 "TAG",固定 128 字节在文件尾
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

/**
 * 读 wav 文件的格式信息(fmt chunk)和音频数据范围(data chunk)。
 * 只读前 1MB(fmt chunk 通常在 data 前,1MB 足够覆盖头 + fmt),不读完整个 data。
 * 供 streamWav 重写 RIFF 头用。
 */
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
    // 遍历 RIFF chunks 找 fmt(格式)和 data(音频数据范围)
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
      // RIFF chunk 是 2 字节对齐:奇数 size 的 chunk 后有 1 字节 padding,size%2 跳过。
      offset = body + size + (size % 2);
    }
    throw new Error(`WAV segment has no readable data chunk: ${file}`);
  } finally {
    await handle.close();
  }
}

/** 校验所有分段 wav 格式一致(采样率/声道/位深等)。不一致抛错--拼一起会按第一段参数播第二段,变调。 */
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

/** 生成 44 字节标准 WAV 头:用第一段格式 + 总 dataBytes(合并后 data size 变了,头必须重写)。 */
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

/**
 * 原子替换:tmp -> target。Linux/macOS rename 能原子覆盖;Windows 不能(EEXIST/EPERM),
 * 要先 rm 再 rename。rm 与 rename 间非原子是 Windows 固有限制,接受微小窗口。
 */
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
