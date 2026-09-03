// 登记完整的逐句音频，并在合并结束后按数量与总字节淘汰最旧片段。

import type { SpeechSegmentsRepo } from '@ema-agent/storage';
import type { AudioArchive } from './audioArchive.js';
import type { CompletedSpeechSegment } from './speechCoordinator.js';
import {
  SPEECH_SEGMENT_MAX_BYTES,
  SPEECH_SEGMENT_MAX_FILES,
} from './limits.js';

const CLEANUP_BATCH_SIZE = 128;

export class SpeechSegmentLibrary {
  constructor(
    private readonly segments: SpeechSegmentsRepo,
    private readonly archive: AudioArchive,
  ) {}

  record(segment: CompletedSpeechSegment): void {
    this.segments.record({
      id: segment.id,
      turnId: segment.turnId,
      sessionId: segment.sessionId,
      sentenceIndex: segment.sentenceIndex,
      storagePath: segment.storagePath,
      mimeType: segment.mimeType,
      byteSize: segment.byteSize,
      durationMs: segment.durationMs,
      text: segment.text,
      createdAt: segment.createdAt,
    });
  }

  /**
   * 必须在本 Turn 合并结束后执行；生成途中删除当前 Turn 的旧片段会让最终音频缺句。
   * 文件先删、SQL 行后删。进程若恰好中断，最多留下一个指向缺失文件的行，下次清理继续淘汰。
   */
  enforceLimits(): void {
    const usage = this.segments.usage();
    let fileCount = usage.fileCount;
    let totalBytes = usage.totalBytes;

    while (fileCount > SPEECH_SEGMENT_MAX_FILES || totalBytes > SPEECH_SEGMENT_MAX_BYTES) {
      const oldest = this.segments.listOldest(CLEANUP_BATCH_SIZE);
      if (oldest.length === 0) return;

      let removedInBatch = 0;
      for (const segment of oldest) {
        try {
          this.archive.removeSegment(segment.storage_path);
        } catch (error) {
          console.warn(`[speech] 无法删除过期音频片段: ${segment.storage_path}`, error);
          continue;
        }
        this.segments.delete(segment.id);
        fileCount -= 1;
        totalBytes -= segment.byte_size;
        removedInBatch += 1;
        if (fileCount <= SPEECH_SEGMENT_MAX_FILES && totalBytes <= SPEECH_SEGMENT_MAX_BYTES) return;
      }

      // 一整批文件都无法删除时停止，避免同步清理死循环；下次完成 TTS 后会再尝试。
      if (removedInBatch === 0) return;
    }
  }

  discardTurn(turnId: string): void {
    this.segments.deleteTurn(turnId);
  }
}
