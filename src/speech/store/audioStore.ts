import type { Database } from '@ema-agent/storage';
import { logging } from '@ema-agent/logging';
import { AudioFileStore, type AudioRead } from './audioFileStore.js';
import { AudioOutputStore } from './audioOutputStore.js';
import { AudioSegmentStore } from './audioSegmentStore.js';
import { SpeechRequestError } from '../errors.js';
import type { AudioRecordEvent } from '../events.js';
import type { AudioPlayback, AudioRecord, AudioSummary, SavedAudioSegment, SpeechAudioIdentity } from '../types.js';

export class AudioStore {
  readonly files: AudioFileStore;
  readonly outputs: AudioOutputStore;
  readonly segments: AudioSegmentStore;
  /** 仅合并当前进程同一 ID 的并发删除请求. SQL 的 deleting 状态还可表示上次删除未完成. */
  private readonly deletionsByAudioId = new Map<string, Promise<void>>();

  constructor(
    private readonly database: Database,
    audioRootDirectory: string,
    private readonly emitAudioRecordEvent: (event: AudioRecordEvent) => void,
  ) {
    this.files = new AudioFileStore(audioRootDirectory);
    this.outputs = new AudioOutputStore(database);
    this.segments = new AudioSegmentStore(database);
  }

  createAudioRecord(identity: SpeechAudioIdentity): void {
    this.outputs.createAudioRecord(identity, this.files.getNewAudioFilePath(identity));
    this.emitRecordChanged(identity, 'generating');
  }

  listAudioSummaries(turnId: string, characterName?: string): AudioSummary[] {
    return this.outputs.listAudioSummaries(turnId, characterName);
  }

  async saveCompletedAudio(
    audioId: string,
    segments: readonly SavedAudioSegment[],
    signal?: AbortSignal,
  ): Promise<AudioSummary | null> {
    try {
      const audioRecord = this.outputs.findByAudioId(audioId);
      if (!audioRecord) throw new Error('Audio record is missing');
      signal?.throwIfAborted();
      const audioFile = await this.files.finishWrite(audioId);
      signal?.throwIfAborted();
      if (!audioFile) {
        // finishWrite 已清理空文件, 或本次根本没有创建文件, 只需移除预先登记的记录.
        this.outputs.deleteAudioRecord(audioId);
        this.emitRecordChanged(audioRecord, 'deleted');
        return null;
      }
      // ready 与段表一起提交. 前端收到 ready 时, 对应字幕已经能从 SQL 读取.
      this.database.sqlite.transaction(() => {
        this.outputs.completeAudioFile(audioFile);
        this.segments.saveSegments(audioId, segments);
      })();
      this.emitRecordChanged(audioFile, 'ready');
      // 使用本次已提交的值返回, 不在提交后再查询并把查询错误误判成需要清理的新文件.
      return {
        audioId,
        characterName: audioRecord.characterName,
        audioStatus: 'ready',
        createdAtMs: audioRecord.createdAtMs,
        durationMs: audioFile.durationMs,
        fileSizeBytes: audioFile.fileSizeBytes,
        failureMessage: null,
      };
    } catch (error) {
      // 文件或入库失败后保留原始错误. 清理失败会由 discardFailedAudio 留下 failed 记录.
      await this.discardFailedAudio(audioId, this.errorMessage(error)).catch(cleanupError => {
        if (cleanupError instanceof SpeechRequestError && cleanupError.code === 'speech/audio_status_save_failed') {
          throw new SpeechRequestError(cleanupError.code, this.errorMessage(error) + '; ' + cleanupError.message);
        }
        logging({ level: 'warn', target: 'speech', event: 'speech.audio_cleanup_failed', error: cleanupError });
      });
      throw error;
    }
  }

  async discardFailedAudio(audioId: string, failureMessage: string): Promise<void> {
    const audioRecord = this.outputs.findByAudioId(audioId);
    if (!audioRecord) return;
    try {
      await this.files.closeAudioReads(audioId);
      await this.files.discardWrite(audioId);
      await this.deleteAudioFiles(audioRecord);
      this.outputs.deleteAudioRecord(audioId);
      this.emitRecordChanged(audioRecord, 'deleted');
    } catch (error) {
      this.markAudioFailed(audioRecord, failureMessage + '; 清理未完成: ' + this.errorMessage(error));
      throw error;
    }
  }

  deleteAudio(audioId: string): Promise<void> {
    const currentDeletion = this.deletionsByAudioId.get(audioId);
    if (currentDeletion) return currentDeletion;
    const deletionCompletion = Promise.resolve().then(() => this.deleteStoredAudio(audioId));
    this.deletionsByAudioId.set(audioId, deletionCompletion);
    // 返回的 Promise 将错误交给 HTTP 调用者, 清理登记的分支不再次制造未处理拒绝.
    void deletionCompletion.finally(() => this.deletionsByAudioId.delete(audioId)).catch(() => undefined);
    return deletionCompletion;
  }

  markInterruptedAudioRecordsFailed(): void {
    for (const audioRecord of this.outputs.markInterruptedAudioRecordsFailed()) {
      this.emitRecordChanged(audioRecord, 'failed');
    }
  }

  getAudioPlayback(audioId: string): AudioPlayback | null {
    const audioRecord = this.outputs.findByAudioId(audioId);
    if (!audioRecord || (audioRecord.audioStatus !== 'ready' && audioRecord.audioStatus !== 'generating')) return null;
    return {
      audioId,
      sessionId: audioRecord.sessionId,
      turnId: audioRecord.turnId,
      characterName: audioRecord.characterName,
      segments: this.segments.getSegments(audioId),
    };
  }

  async openRead(audioId: string, signal: AbortSignal): Promise<AudioRead | null> {
    const audioRecord = this.outputs.findByAudioId(audioId);
    if (!audioRecord || (audioRecord.audioStatus !== 'ready' && audioRecord.audioStatus !== 'generating')) return null;
    const audioRead = await this.files.openRead(audioId, audioRecord.storagePath, signal);
    const currentRecord = this.outputs.findByAudioId(audioId);
    // 打开文件期间可能已经开始删除. 不能把迟到的句柄交给 HTTP 继续读取.
    if (audioRead && (!currentRecord || currentRecord.audioStatus === 'deleting' || currentRecord.audioStatus === 'failed')) {
      audioRead.stream.destroy();
      return null;
    }
    return audioRead;
  }

  private async deleteStoredAudio(audioId: string): Promise<void> {
    const audioRecord = this.outputs.findByAudioId(audioId);
    if (!audioRecord) return;
    if (audioRecord.audioStatus === 'generating') {
      throw new SpeechRequestError('speech/audio_generating', '请先取消这条音频的生成');
    }
    if (!this.outputs.updateAudioStatus(audioId, 'deleting', null)) return;
    this.emitRecordChanged(audioRecord, 'deleting');
    try {
      await this.files.closeAudioReads(audioId);
      await this.deleteAudioFiles(audioRecord);
      this.outputs.deleteAudioRecord(audioId);
      this.emitRecordChanged(audioRecord, 'deleted');
    } catch (error) {
      this.markAudioFailed(audioRecord, '删除未完成: ' + this.errorMessage(error));
      throw error;
    }
  }

  private async deleteAudioFiles(audioRecord: AudioRecord): Promise<void> {
    // 两个路径都属于同一个数据库 AudioID. 文件不存在也算清理完成, 支持中断后的重复删除.
    await this.files.deleteFile(audioRecord.storagePath + '.tmp');
    await this.files.deleteFile(audioRecord.storagePath);
  }

  private markAudioFailed(audioRecord: AudioRecord, failureMessage: string): void {
    // SQL 本身失败就向调用者报错, 不发送一条并未保存成功的 failed 通知.
    try {
      // 等待磁盘期间 Session 可能已被删除, 没有记录时也就没有 failed 状态可广播.
      if (!this.outputs.updateAudioStatus(audioRecord.audioId, 'failed', failureMessage)) return;
    } catch (error) {
      throw new SpeechRequestError('speech/audio_status_save_failed', '音频失败状态未能保存: ' + this.errorMessage(error));
    }
    this.emitRecordChanged(audioRecord, 'failed');
  }

  private emitRecordChanged(identity: SpeechAudioIdentity, audioStatus: AudioRecordEvent['audioStatus']): void {
    try {
      this.emitAudioRecordEvent({
        type: 'session_audio_changed',
        audioId: identity.audioId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        characterName: identity.characterName,
        audioStatus,
      });
    } catch (error) {
      // SQL 已成功, 通知失败不能撤销记录或阻止生成收尾.
      logging({ level: 'warn', target: 'speech', event: 'speech.notification_failed', error });
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
