import { describe, expect, it } from 'vitest';
import {
  SESSION_RECORD_PATHS,
  isSessionArchivePath,
} from '../records/sessionFormat.js';

describe('sessionFormat', () => {
  it('为每类记录提供唯一文件', () => {
    const paths = Object.values(SESSION_RECORD_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SESSION_RECORD_PATHS.messages).toBe('records/messages.jsonl');
    expect(SESSION_RECORD_PATHS.goals).toBe('records/goals.jsonl');
    expect(SESSION_RECORD_PATHS.subagentRuns).toBe('records/subagentRuns.jsonl');
  });

  it('只接受已登记记录和三类 Session 文件', () => {
    expect(isSessionArchivePath('manifest.json')).toBe(true);
    expect(isSessionArchivePath('files/attachments/u1.png')).toBe(true);
    expect(isSessionArchivePath('records/legacy.jsonl')).toBe(false);
    expect(isSessionArchivePath('records/subagentInvocations.jsonl')).toBe(false);
    expect(isSessionArchivePath('files/unknown/file')).toBe(false);
  });
});
