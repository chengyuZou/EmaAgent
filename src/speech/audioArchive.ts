import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createPcmWavHeader, type PcmAudioFormat } from '@ema-agent/tts';

const AUDIO_READ_BYTES = 64 * 1024;
const PCM_SAMPLE_BYTES = 2;
const MILLISECONDS_PER_SECOND = 1000;

export interface FinalizedAudio {
  readonly storagePath: string;
  readonly mimeType: 'audio/wav';
  readonly byteSize: number;
  readonly durationMs: number;
}

export interface AudioWriter {
  /** 等这一块写入文件后才返回, 调用方必须 await 后再取下一块 PCM. */
  write(bytes: Uint8Array): Promise<void>;
  /** 完成 WAV 头并发布文件; 未写入 PCM 时删除空文件并返回 null. */
  finish(): Promise<FinalizedAudio | null>;
}

export interface AudioRead {
  readonly stream: Readable;
  readonly mimeType: 'audio/wav';
  /** 正在写入时最终大小未知, HTTP 响应不能设置 Content-Length. */
  readonly byteSize: number | null;
}

export class FsAudioArchive {
  private readonly writing = new Map<string, AudioFile>();

  constructor(private readonly sessionsRoot: string) {}

  async openTurn(sessionId: string, turnId: string, format: PcmAudioFormat): Promise<AudioWriter> {
    const storagePath = this.audioPath(sessionId, turnId);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
    const file = new AudioFile(storagePath, format, () => this.writing.delete(turnId));
    await file.initialize();
    this.writing.set(turnId, file);
    return file;
  }

  async openRead(sessionId: string, turnId: string, signal: AbortSignal): Promise<AudioRead | null> {
    signal.throwIfAborted();
    const file = this.writing.get(turnId);
    if (file) {
      const readAbort = new AbortController();
      const readSignal = AbortSignal.any([signal, readAbort.signal]);
      const source = Readable.from(file.read(readSignal), {
        objectMode: false,
        highWaterMark: AUDIO_READ_BYTES,
        signal: readSignal,
      });
      const stream = new PassThrough({ highWaterMark: AUDIO_READ_BYTES });
      // HTTP 消费方关闭流时, 也要解除文件末尾的等待, 但不触碰合成的取消信号.
      stream.once('close', () => readAbort.abort('audio reader closed'));
      // pipeline 把读取错误交给返回的 stream; Promise 不能再留下未处理的拒绝.
      void pipeline(source, stream, { signal: readSignal }).catch(() => undefined);
      return {
        stream,
        mimeType: 'audio/wav',
        byteSize: null,
      };
    }

    const found = this.findFinalized(sessionId, turnId);
    if (!found) return null;
    const stat = await fs.promises.stat(found.storagePath);
    return {
      stream: fs.createReadStream(found.storagePath, { signal, highWaterMark: AUDIO_READ_BYTES }),
      mimeType: found.mimeType,
      byteSize: stat.size,
    };
  }

  findFinalized(
    sessionId: string,
    turnId: string,
  ): Pick<FinalizedAudio, 'storagePath' | 'mimeType'> | null {
    const storagePath = this.audioPath(sessionId, turnId);
    return fs.existsSync(storagePath) ? { storagePath, mimeType: 'audio/wav' } : null;
  }

  private audioPath(sessionId: string, turnId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'audio', `${turnId}.wav`);
  }
}

/** 写入进度只记录已完成的文件字节数; 读取方自行持有位置, 不保存第二份整轮 PCM. */
class AudioFile implements AudioWriter {
  private readonly pendingPath: string;
  private readonly output: fs.WriteStream;
  private readonly headerBytes: number;
  private readonly readers = new Set<() => void>();
  private pcmByteSize = 0;
  private completed = false;
  private writeError: Error | null = null;
  private finishPromise: Promise<FinalizedAudio | null> | null = null;

  constructor(
    private readonly storagePath: string,
    private readonly format: PcmAudioFormat,
    private readonly onFinished: () => void,
  ) {
    this.pendingPath = `${storagePath}.pending`;
    this.headerBytes = createPcmWavHeader(format, null).byteLength;
    this.output = fs.createWriteStream(this.pendingPath, { flags: 'wx' });
    // WriteStream 的 error 事件必须被接收; write 的 Promise 仍会把失败交给 Coordinator.
    this.output.on('error', error => {
      this.writeError = error;
    });
  }

  async initialize(): Promise<void> {
    try {
      await this.writeBytes(createPcmWavHeader(this.format, null));
    } catch (error) {
      await this.finish().catch(() => undefined);
      throw error;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writeBytes(bytes);
    this.pcmByteSize += bytes.byteLength;
    this.notifyReaders();
  }

  finish(): Promise<FinalizedAudio | null> {
    this.finishPromise ??= this.finishInternal();
    return this.finishPromise;
  }

  async *read(signal: AbortSignal): AsyncGenerator<Uint8Array> {
    // 请求可能恰好遇到 pending 改名; 打开失败时只尝试它对应的正式文件.
    const handle = await fs.promises.open(this.pendingPath, 'r').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return fs.promises.open(this.storagePath, 'r');
    });
    let position = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const available = this.headerBytes + this.pcmByteSize - position;
        if (available > 0) {
          const bytes = Buffer.allocUnsafe(Math.min(AUDIO_READ_BYTES, available));
          const result = await handle.read(bytes, 0, bytes.byteLength, position);
          if (result.bytesRead === 0) throw new Error('Speech audio file ended before its written bytes');
          position += result.bytesRead;
          yield bytes.subarray(0, result.bytesRead);
        } else if (this.completed) {
          return;
        } else {
          // 读到当前文件末尾时等待下一次写入, 不能把句间停顿当成整轮结束.
          await this.waitForWrite(signal);
        }
      }
    } finally {
      await handle.close();
    }
  }

  private writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.writeError) return Promise.reject(this.writeError);
    return new Promise((resolve, reject) => {
      // 这一块的文件写入完成前不继续读取 TTS, 磁盘慢时不会堆积全部音频块.
      this.output.write(bytes, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async finishInternal(): Promise<FinalizedAudio | null> {
    try {
      const closed = finished(this.output, { cleanup: true });
      if (!this.output.destroyed) this.output.end();
      await closed.catch(error => {
        if (!this.writeError) throw error;
      });
      if (this.pcmByteSize === 0) {
        await fs.promises.rm(this.pendingPath, { force: true });
        return null;
      }

      const handle = await fs.promises.open(this.pendingPath, 'r+');
      try {
        // 写入失败的最后一块可能只落下部分字节, 只保留已确认写完的 PCM.
        await handle.truncate(this.headerBytes + this.pcmByteSize);
        await handle.writeFile(createPcmWavHeader(this.format, this.pcmByteSize));
      } finally {
        await handle.close();
      }
      await fs.promises.rename(this.pendingPath, this.storagePath);
      const frames = this.pcmByteSize / (this.format.channelCount * PCM_SAMPLE_BYTES);
      return {
        storagePath: this.storagePath,
        mimeType: 'audio/wav',
        byteSize: this.headerBytes + this.pcmByteSize,
        durationMs: Math.round(frames / this.format.sampleRate * MILLISECONDS_PER_SECOND),
      };
    } catch (error) {
      await fs.promises.rm(this.pendingPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.completed = true;
      this.notifyReaders();
      this.onFinished();
    }
  }

  private waitForWrite(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const written = (): void => {
        signal.removeEventListener('abort', aborted);
        this.readers.delete(written);
        resolve();
      };
      const aborted = (): void => {
        this.readers.delete(written);
        reject(signal.reason);
      };
      this.readers.add(written);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  private notifyReaders(): void {
    for (const reader of this.readers) reader();
  }
}
