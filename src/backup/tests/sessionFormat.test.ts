// 验证 Session ZIP 的固定记录路径和资源白名单不会出现两份真相。
import { describe, expect, it } from 'vitest';
import {
  SESSION_RECORD_FILES,
  isSessionArchivePath,
  sessionRecordFile,
} from '../records/sessionFormat.js';

describe('sessionFormat', () => {
  it('为每类记录提供唯一文件', () => {
    expect(new Set(SESSION_RECORD_FILES.map(file => file.path)).size)
      .toBe(SESSION_RECORD_FILES.length);
    expect(sessionRecordFile('messages').path).toBe('records/messages.jsonl');
  });

  it('只接受已登记记录和四类 Session 文件', () => {
    expect(isSessionArchivePath('manifest.json')).toBe(true);
    expect(isSessionArchivePath('files/speechSegments/segment.mp3')).toBe(true);
    expect(isSessionArchivePath('records/legacy.jsonl')).toBe(false);
    expect(isSessionArchivePath('files/unknown/file')).toBe(false);
  });
});
