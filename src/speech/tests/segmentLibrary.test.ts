// 测试逐句音频片段库超过包内固定文件数或字节上限时删除最旧记录.

import type { SpeechSegmentsRepo } from '@ema-agent/storage';
import { describe, expect, it, vi } from 'vitest';
import type { AudioArchive } from '../audioArchive.js';
import {
  SPEECH_SEGMENT_MAX_BYTES,
  SPEECH_SEGMENT_MAX_FILES,
} from '../limits.js';
import { SpeechSegmentLibrary } from '../segmentLibrary.js';

describe('SpeechSegmentLibrary', () => {
  it('超过固定文件数上限时删除最旧片段', () => {
    const removeSegment = vi.fn();
    const deleteRecord = vi.fn();
    const repo = {
      usage: () => ({
        fileCount: SPEECH_SEGMENT_MAX_FILES + 1,
        totalBytes: 2,
      }),
      listOldest: () => [{
        id: 'oldest',
        storage_path: 'session/audio/oldest.pcm',
        byte_size: 2,
      }],
      delete: deleteRecord,
    } as unknown as SpeechSegmentsRepo;
    const archive = { removeSegment } as unknown as AudioArchive;

    new SpeechSegmentLibrary(repo, archive).enforceLimits();

    expect(removeSegment).toHaveBeenCalledWith('session/audio/oldest.pcm');
    expect(deleteRecord).toHaveBeenCalledWith('oldest');
  });

  it('超过固定字节上限时删除最旧片段', () => {
    const removeSegment = vi.fn();
    const deleteRecord = vi.fn();
    const repo = {
      usage: () => ({
        fileCount: 1,
        totalBytes: SPEECH_SEGMENT_MAX_BYTES + 1,
      }),
      listOldest: () => [{
        id: 'oldest',
        storage_path: 'session/audio/oldest.pcm',
        byte_size: SPEECH_SEGMENT_MAX_BYTES + 1,
      }],
      delete: deleteRecord,
    } as unknown as SpeechSegmentsRepo;
    const archive = { removeSegment } as unknown as AudioArchive;

    new SpeechSegmentLibrary(repo, archive).enforceLimits();

    expect(removeSegment).toHaveBeenCalledWith('session/audio/oldest.pcm');
    expect(deleteRecord).toHaveBeenCalledWith('oldest');
  });
});
