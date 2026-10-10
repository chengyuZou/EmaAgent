import type { Readable } from 'node:stream';
import { TtsError } from '../errors.js';
import type { PcmAudioFormat, TtsStreamEvent } from '../types.js';
import { pcmEvents, PCM_SAMPLE_BYTES } from './pcm.js';

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const PCM_FORMAT_BYTES = 16;
const PCM_FORMAT_CODE = 1;
const PCM_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES * 2 + PCM_FORMAT_BYTES;
const RIFF_SIZE_FIELD_BYTES = 8;
const UNKNOWN_WAV_BYTE_SIZE = 0xffffffff;

/** 读取 GPT-SoVITS 的 PCM16LE WAV, 保留文件头中的采样率和声道数. */
export async function* gptSoVitsWavEvents(
  input: Readable,
  startedAt: number,
  signal?: AbortSignal,
): AsyncGenerator<TtsStreamEvent> {
  const reader = new WavReader(input);
  const abort = (): void => {
    input.destroy(new TtsError('tts/aborted', 'TTS WAV request was aborted', signal?.reason));
  };

  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    const header = await reader.read(RIFF_HEADER_BYTES);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new TtsError('tts/invalid_response', 'TTS response is not a RIFF WAV');
    }

    let format: PcmAudioFormat | undefined;
    while (true) {
      const chunkHeader = await reader.read(CHUNK_HEADER_BYTES);
      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkLength = chunkHeader.readUInt32LE(4);
      if (chunkId === 'fmt ') {
        if (chunkLength < PCM_FORMAT_BYTES) {
          throw new TtsError('tts/invalid_response', 'TTS WAV has an incomplete PCM format');
        }
        format = readPcmFormat(await reader.read(PCM_FORMAT_BYTES));
        await reader.skip(chunkLength - PCM_FORMAT_BYTES + chunkLength % 2);
      } else if (chunkId === 'data') {
        if (!format) {
          throw new TtsError('tts/invalid_response', 'TTS WAV audio precedes its format');
        }
        yield* pcmEvents(readAudioChunks(reader, chunkLength), format, startedAt);
        return;
      } else {
        // LIST 等非音频块可能夹在格式和样本之间, 连同奇数长度的填充字节一起跳过.
        await reader.skip(chunkLength + chunkLength % 2);
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new TtsError('tts/aborted', 'TTS WAV request was aborted', error);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    // 成功、失败和调用方提前停止迭代都会结束输入, 不再继续下载这次合成结果.
    input.destroy();
    await reader.close();
  }
}

/** 给已完成且由调用方限制大小的 PCM 写 WAV 头, 不转换或重新采样. */
export function packPcmWav(chunks: readonly Uint8Array[], format: PcmAudioFormat): Uint8Array {
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = createPcmWavHeader(format, dataBytes);
  const wav = Buffer.alloc(header.byteLength + dataBytes);
  wav.set(header);
  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return wav;
}

/** pcmByteSize 为 null 时写未知长度, 供持续追加 PCM 的音频响应使用. */
export function createPcmWavHeader(format: PcmAudioFormat, pcmByteSize: number | null): Uint8Array {
  const frameBytes = format.channelCount * PCM_SAMPLE_BYTES;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  const riffByteSize = pcmByteSize === null
    ? UNKNOWN_WAV_BYTE_SIZE
    : WAV_HEADER_BYTES - RIFF_SIZE_FIELD_BYTES + pcmByteSize;
  header.writeUInt32LE(riffByteSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(PCM_FORMAT_BYTES, 16);
  header.writeUInt16LE(PCM_FORMAT_CODE, 20);
  header.writeUInt16LE(format.channelCount, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmByteSize ?? UNKNOWN_WAV_BYTE_SIZE, 40);
  return header;
}

function readPcmFormat(bytes: Buffer): PcmAudioFormat {
  const formatCode = bytes.readUInt16LE(0);
  const channelCount = bytes.readUInt16LE(2);
  const sampleRate = bytes.readUInt32LE(4);
  const byteRate = bytes.readUInt32LE(8);
  const frameBytes = bytes.readUInt16LE(12);
  const bitsPerSample = bytes.readUInt16LE(14);
  if (formatCode !== PCM_FORMAT_CODE || bitsPerSample !== PCM_BITS_PER_SAMPLE) {
    throw new TtsError('tts/invalid_response', 'TTS WAV must contain signed PCM16LE samples');
  }
  if ((channelCount !== 1 && channelCount !== 2) || sampleRate === 0
    || frameBytes !== channelCount * PCM_SAMPLE_BYTES || byteRate !== sampleRate * frameBytes) {
    throw new TtsError('tts/invalid_response', 'TTS WAV has an invalid PCM format');
  }
  return { sampleRate, channelCount };
}

async function* readAudioChunks(reader: WavReader, dataBytes: number): AsyncGenerator<Uint8Array> {
  // GPT-SoVITS 流式响应的 data 长度为 0, 此时剩余响应直到 EOF 都是 PCM.
  // 有明确长度时只读 data 内容, 不把其后的 WAV 元数据当成声音样本.
  const untilEnd = dataBytes === 0;
  let remaining = untilEnd ? Infinity : dataBytes;
  while (remaining > 0) {
    const bytes = await reader.take(remaining);
    if (!bytes) {
      if (untilEnd) {
        return;
      }
      throw new TtsError('tts/invalid_response', 'TTS WAV audio ended before its declared length');
    }
    remaining -= bytes.byteLength;
    yield bytes;
  }
}

/** 只保存当前网络块; 小段文件头允许跨块读取, 跳过元数据不创建同等大小的缓冲. */
class WavReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private unread: Uint8Array = new Uint8Array(0);

  constructor(input: Readable) {
    this.iterator = input[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Buffer> {
    const result = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytes = await this.take(length - offset);
      if (!bytes) {
        throw new TtsError('tts/invalid_response', 'TTS WAV header ended unexpectedly');
      }
      result.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return result;
  }

  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const bytes = await this.take(remaining);
      if (!bytes) {
        throw new TtsError('tts/invalid_response', 'TTS WAV metadata ended unexpectedly');
      }
      remaining -= bytes.byteLength;
    }
  }

  async take(maxBytes: number): Promise<Uint8Array | undefined> {
    while (this.unread.byteLength === 0) {
      const next = await this.iterator.next();
      if (next.done) {
        return undefined;
      }
      this.unread = next.value;
    }
    const bytes = this.unread.subarray(0, maxBytes);
    this.unread = this.unread.subarray(bytes.byteLength);
    return bytes;
  }

  async close(): Promise<void> {
    // 输入销毁后还要结束它的迭代器, 让 Node 移除迭代期间注册的流监听器.
    await this.iterator.return?.();
  }
}
