import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { FileHandle } from 'node:fs/promises';
import { logging } from '@ema-agent/logging';
import { createPcmWavHeader, type PcmAudioFormat } from '@ema-agent/tts';
import { SpeechRequestError } from '../errors.js';
import type { CompletedAudioFile, SpeechAudioIdentity } from '../types.js';

const AUDIO_READ_BYTES = 64 * 1024;
const PCM_SAMPLE_BYTES = 2;

type AudioWriteState = 'writing' | 'closing' | 'closed';

export interface AudioRead {
  readonly stream: Readable;
  readonly mimeType: 'audio/wav';
  /** 正在生成的 WAV 最终大小未知, HTTP 必须省略 Content-Length. */
  readonly byteSize: number | null;
}

interface AudioWrite {
  readonly identity: SpeechAudioIdentity;
  readonly format: PcmAudioFormat;
  /** 最终 WAV 路径. 写入流使用同名 .tmp, 完成后只改名本次 AudioID 的文件. */
  readonly storagePath: string;
  readonly wavWriteStream: fs.WriteStream;
  readonly headerBytes: number;
  /** 只包含读到当前尾部的读者. 写入或关闭后唤醒, 读者取消时移除自己的回调. */
  readonly waitingAudioReaders: Set<() => void>;
  /** 已确认写入的 PCM 字节数, 不含 WAV 头和失败写入留下的半块数据. */
  writtenPCMBytes: number;
  writeError: Error | null;
  /** closing 拒绝新 PCM; closed 允许读者读完已有字节后结束, 不表示 SQL 保存成功. */
  writeState: AudioWriteState;
}

export class AudioFileStore {
  /** 仅保存活跃写入. 结束写入后移除, 已打开读者仍持有原状态和自己的文件句柄. */
  private readonly activeWritesByAudioId = new Map<string, AudioWrite>();
  /** 删除音频前中断并等待其读者关闭句柄, 关闭读取不会取消 TTS. */
  private readonly activeReadsByAudioId = new Map<string, Set<{
    abortController: AbortController;
    closeCompletion: Promise<void>;
  }>>();

  constructor(private readonly audioRootDirectory: string) {}

  /** SpeechGenerator 按顺序等待每块写入完成, 不并发追加同一份音频. */
  async appendPCM(identity: SpeechAudioIdentity, format: PcmAudioFormat, bytes: Uint8Array): Promise<void> {
    let audioWrite = this.activeWritesByAudioId.get(identity.audioId);
    if (!audioWrite) audioWrite = await this.beginAudioWrite(identity, format);
    if (audioWrite.writeState !== 'writing') throw new Error('Speech audio is already closing');
    if (audioWrite.format.sampleRate !== format.sampleRate || audioWrite.format.channelCount !== format.channelCount) {
      throw new Error('TTS PCM format changed within one audio output');
    }
    await this.writeBytes(audioWrite, bytes);
    audioWrite.writtenPCMBytes += bytes.byteLength;
    this.notifyAudioReaders(audioWrite);
  }

  /** 没有活跃写入时返回 0. finishWrite 返回的文件信息和 Output 记录保留完成时长. */
  getWrittenDurationMs(audioId: string): number {
    const audioWrite = this.activeWritesByAudioId.get(audioId);
    if (!audioWrite) return 0;
    return audioWrite.writtenPCMBytes / (audioWrite.format.channelCount * PCM_SAMPLE_BYTES)
      / audioWrite.format.sampleRate * 1000;
  }

  /** 只完成 WAV, 不保存 SQL. 返回前唤醒读者结束等待; 没有 PCM 时删除文件并返回 null. */
  async finishWrite(audioId: string): Promise<CompletedAudioFile | null> {
    const audioWrite = this.activeWritesByAudioId.get(audioId);
    if (!audioWrite) return null;
    if (audioWrite.writeState !== 'writing') throw new Error('Speech audio is already closing');
    audioWrite.writeState = 'closing';
    try {
      await this.closeWriteStream(audioWrite);
      if (audioWrite.writtenPCMBytes === 0) {
        await this.deleteFile(audioWrite.storagePath + '.tmp');
        return null;
      }
      const fileHandle = await fs.promises.open(audioWrite.storagePath + '.tmp', 'r+');
      try {
        // 失败写入可能留下半块数据, 只保留已确认字节, 再补上真实的 WAV 长度.
        await fileHandle.truncate(audioWrite.headerBytes + audioWrite.writtenPCMBytes);
        await fileHandle.writeFile(createPcmWavHeader(audioWrite.format, audioWrite.writtenPCMBytes));
      } finally {
        await fileHandle.close();
      }
      await fs.promises.rename(audioWrite.storagePath + '.tmp', audioWrite.storagePath);
      return {
        ...audioWrite.identity,
        storagePath: audioWrite.storagePath,
        mimeType: 'audio/wav',
        fileSizeBytes: audioWrite.headerBytes + audioWrite.writtenPCMBytes,
        durationMs: Math.round(this.getWrittenDurationMs(audioId)),
      };
    } finally {
      this.endAudioWrite(audioWrite);
    }
  }

  /** 手动生成失败或取消时丢弃本次文件. 调用前生成器已停止追加 PCM. */
  async discardWrite(audioId: string): Promise<void> {
    const audioWrite = this.activeWritesByAudioId.get(audioId);
    if (!audioWrite) return;
    if (audioWrite.writeState !== 'writing') throw new Error('Speech audio is already closing');
    audioWrite.writeState = 'closing';
    try {
      await this.closeWriteStream(audioWrite);
    } finally {
      try {
        await this.deleteFile(audioWrite.storagePath + '.tmp');
      } finally {
        this.endAudioWrite(audioWrite);
      }
    }
  }

  /** 只删除调用者已结束写入的音频. 文件不存在表示无需清理, 其他磁盘错误交给调用者. */
  async deleteFile(storagePath: string): Promise<void> {
    await fs.promises.rm(storagePath, { force: true });
  }

  async closeAudioReads(audioId: string): Promise<void> {
    const audioReads = [...(this.activeReadsByAudioId.get(audioId) ?? [])];
    for (const audioRead of audioReads) audioRead.abortController.abort('audio deleted');
    await Promise.all(audioReads.map(audioRead => audioRead.closeCompletion));
  }

  /**
   * AudioStore 先检查 SQL 状态, 再传入记录中的路径, 支持已有 WAV 的原文件名.
   * 读取期间只有本次 AudioID 的 .tmp 会改名, 不猜测当前角色的另一份音频.
   */
  async openRead(
    audioId: string,
    storagePath: string,
    signal: AbortSignal,
  ): Promise<AudioRead | null> {
    signal.throwIfAborted();
    const audioWrite = this.activeWritesByAudioId.get(audioId);
    const readAbortController = new AbortController();
    const readSignal = AbortSignal.any([signal, readAbortController.signal]);
    let fileHandle: FileHandle;
    try {
      const readPath = audioWrite && audioWrite.writeState !== 'closed' ? storagePath + '.tmp' : storagePath;
      try {
        fileHandle = await fs.promises.open(readPath, 'r');
      } catch (error) {
        // finishWrite 可能在 open 期间完成改名. 同一 AudioID 的最终路径仍对应这份音频.
        if (readPath === storagePath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fileHandle = await fs.promises.open(storagePath, 'r');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    if (!audioWrite || audioWrite.writeState === 'closed') {
      try {
        const stat = await fileHandle.stat();
        const stream = fileHandle.createReadStream({ signal: readSignal, highWaterMark: AUDIO_READ_BYTES, autoClose: true });
        this.trackAudioRead(audioId, readAbortController, finished(stream, { cleanup: true }).catch(() => undefined));
        return {
          stream,
          mimeType: 'audio/wav',
          byteSize: stat.size,
        };
      } catch (error) {
        await fileHandle.close();
        throw error;
      }
    }

    const source = Readable.from(this.readGrowingAudio(audioWrite, fileHandle, readSignal), {
      objectMode: false,
      highWaterMark: AUDIO_READ_BYTES,
      signal: readSignal,
    });
    const stream = new PassThrough({ highWaterMark: AUDIO_READ_BYTES });
    // 外层流关闭就中断仍在等 PCM 的读取, 只取消这个读者, 不取消语音生成.
    stream.once('close', () => readAbortController.abort('audio reader closed'));
    // pipeline 已把错误交给返回的 stream; 即使读者尚未开始消费也要关闭已打开的句柄.
    const closeCompletion = pipeline(source, stream, { signal: readSignal })
      .catch(() => undefined)
      .finally(() => fileHandle.close())
      .catch(error => logging({ level: 'warn', target: 'speech', event: 'speech.audio_read_close_failed', error }));
    this.trackAudioRead(audioId, readAbortController, closeCompletion);
    return { stream, mimeType: 'audio/wav', byteSize: null };
  }

  getNewAudioFilePath(identity: SpeechAudioIdentity): string {
    const storagePath = this.getAudioFilePath(identity);
    // .tmp 使用 wx 保护写入, 登记前也检查最终路径, 避免改名时覆盖已存在的完整 WAV.
    if (fs.existsSync(storagePath) || fs.existsSync(storagePath + '.tmp')) {
      throw new SpeechRequestError('speech/audio_file_exists', '同一音频 ID 的文件已存在, 不会覆盖');
    }
    return storagePath;
  }

  private getAudioFilePath(identity: SpeechAudioIdentity): string {
    return path.join(
      this.audioRootDirectory,
      identity.sessionId,
      identity.turnId,
      identity.characterName + '-' + identity.audioId + '.wav',
    );
  }

  private async beginAudioWrite(identity: SpeechAudioIdentity, format: PcmAudioFormat): Promise<AudioWrite> {
    const storagePath = this.getAudioFilePath(identity);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
    // 先独占创建成功再登记. 路径已经存在时直接失败, 不清理不属于这次写入的文件.
    const fileHandle = await fs.promises.open(storagePath + '.tmp', 'wx');
    const audioWrite: AudioWrite = {
      identity,
      format,
      storagePath,
      wavWriteStream: fileHandle.createWriteStream({ autoClose: true }),
      headerBytes: createPcmWavHeader(format, null).byteLength,
      waitingAudioReaders: new Set(),
      writtenPCMBytes: 0,
      writeError: null,
      writeState: 'writing',
    };
    audioWrite.wavWriteStream.on('error', error => {
      audioWrite.writeError = error;
    });
    this.activeWritesByAudioId.set(identity.audioId, audioWrite);
    try {
      await this.writeBytes(audioWrite, createPcmWavHeader(format, null));
      return audioWrite;
    } catch (error) {
      await this.discardWrite(identity.audioId).catch(cleanupError => {
        logging({
          level: 'warn',
          target: 'speech',
          event: 'speech.audio_cleanup_failed',
          error: cleanupError,
          body: { storagePath },
        });
      });
      throw error;
    }
  }

  private writeBytes(audioWrite: AudioWrite, bytes: Uint8Array): Promise<void> {
    if (audioWrite.writeError) return Promise.reject(audioWrite.writeError);
    return new Promise((resolve, reject) => {
      // 写入回调成功后才计入 writtenPCMBytes, 不把仅进入 Node 缓冲区的字节提前交给读者.
      audioWrite.wavWriteStream.write(bytes, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async closeWriteStream(audioWrite: AudioWrite): Promise<void> {
    const fileClosed = finished(audioWrite.wavWriteStream, { cleanup: true });
    if (!audioWrite.wavWriteStream.destroyed && !audioWrite.wavWriteStream.writableEnded) {
      audioWrite.wavWriteStream.end();
    }
    await fileClosed.catch(error => {
      // 已确认写入的 PCM 仍可保存, 原始写入错误由 SpeechGenerator 报告.
      if (!audioWrite.writeError) throw error;
    });
  }

  private endAudioWrite(audioWrite: AudioWrite): void {
    audioWrite.writeState = 'closed';
    this.notifyAudioReaders(audioWrite);
    this.activeWritesByAudioId.delete(audioWrite.identity.audioId);
  }

  private async *readGrowingAudio(
    audioWrite: AudioWrite,
    fileHandle: FileHandle,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    let readPositionBytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const availableBytes = audioWrite.headerBytes + audioWrite.writtenPCMBytes - readPositionBytes;
      if (availableBytes > 0) {
        const bytes = Buffer.allocUnsafe(Math.min(AUDIO_READ_BYTES, availableBytes));
        const read = await fileHandle.read(bytes, 0, bytes.byteLength, readPositionBytes);
        if (read.bytesRead === 0) throw new Error('Speech audio ended before its confirmed written bytes');
        readPositionBytes += read.bytesRead;
        yield bytes.subarray(0, read.bytesRead);
      } else if (audioWrite.writeState === 'closed') {
        return;
      } else {
        await this.waitForAudioWrite(audioWrite, signal);
      }
    }
  }

  private waitForAudioWrite(audioWrite: AudioWrite, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const resumeRead = (): void => {
        signal.removeEventListener('abort', cancelRead);
        audioWrite.waitingAudioReaders.delete(resumeRead);
        resolve();
      };
      const cancelRead = (): void => {
        audioWrite.waitingAudioReaders.delete(resumeRead);
        reject(signal.reason);
      };
      audioWrite.waitingAudioReaders.add(resumeRead);
      signal.addEventListener('abort', cancelRead, { once: true });
    });
  }

  private notifyAudioReaders(audioWrite: AudioWrite): void {
    for (const resumeRead of audioWrite.waitingAudioReaders) resumeRead();
  }

  private trackAudioRead(audioId: string, abortController: AbortController, closeCompletion: Promise<void>): void {
    const audioReads = this.activeReadsByAudioId.get(audioId) ?? new Set();
    const audioRead = { abortController, closeCompletion };
    audioReads.add(audioRead);
    this.activeReadsByAudioId.set(audioId, audioReads);
    void closeCompletion.finally(() => {
      audioReads.delete(audioRead);
      if (audioReads.size === 0) this.activeReadsByAudioId.delete(audioId);
    });
  }
}
