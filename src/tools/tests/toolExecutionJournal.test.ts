// 验证工具执行日志的 CAS 状态推进、幂等准备、崩溃恢复和跨 Session 所有权约束。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import { Database, ToolExecutionsRepo } from '@ema-agent/storage';
import {
  ToolExecutionJournal,
} from '../journal/toolExecutionJournal.js';
import { ToolExecutionJournalConflictError } from '../errors.js';

describe('ToolExecutionJournal', () => {
  let database: Database;
  let journal: ToolExecutionJournal;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    database.sqlite.prepare(`
      INSERT INTO turns (
        id, session_id, execution_profile, narrative_policy, trigger_type,
        status, user_input, started_at
      ) VALUES ('turn-a', 'session-a', 'work', 'auto', 'userMessage', 'running', 'test', 1)
    `).run();
    journal = new ToolExecutionJournal(new ToolExecutionsRepo(database.sqlite));
  });

  afterEach(() => database.close());

  it('按 prepared → authorized → running → succeeded 推进并增加版本', () => {
    const callId = asToolCallId('call-a');
    expect(journal.prepare({
      callId,
      sessionId: asSessionId('session-a'),
      turnId: asTurnId('turn-a'),
      toolName: 'write_file',
      input: { path: 'a.txt', content: 'hello' },
    })).toMatchObject({ status: 'prepared', version: 0 });

    expect(journal.authorize(callId)).toMatchObject({ status: 'authorized', version: 1 });
    expect(journal.start(callId)).toMatchObject({ status: 'running', version: 2 });
    expect(journal.succeed(callId, { ok: true })).toMatchObject({
      status: 'succeeded',
      version: 3,
      resultPreview: '{"ok":true}',
    });
  });

  it('相同 callId 只允许同一工具意图幂等重放', () => {
    const args = {
      callId: asToolCallId('call-a'),
      sessionId: asSessionId('session-a'),
      turnId: asTurnId('turn-a'),
      toolName: 'read_file',
      input: { path: 'a.txt' },
    };
    const first = journal.prepare(args);
    const replay = journal.prepare({ ...args, input: { path: 'a.txt' } });
    expect(replay).toEqual(first);

    expect(() => journal.prepare({ ...args, input: { path: 'b.txt' } }))
      .toThrow(ToolExecutionJournalConflictError);
  });

  it('崩溃恢复不会重放已开始的副作用', () => {
    const runningId = asToolCallId('call-running');
    journal.prepare({
      callId: runningId,
      sessionId: asSessionId('session-a'),
      turnId: asTurnId('turn-a'),
      toolName: 'bash',
      input: { command: 'do-something' },
    });
    journal.authorize(runningId);
    journal.start(runningId);

    const preparedId = asToolCallId('call-prepared');
    journal.prepare({
      callId: preparedId,
      sessionId: asSessionId('session-a'),
      turnId: asTurnId('turn-a'),
      toolName: 'read_file',
      input: { path: 'a.txt' },
    });

    journal.recoverInterrupted();
    expect(journal.get(runningId)?.status).toBe('outcome_unknown');
    expect(journal.get(preparedId)?.status).toBe('cancelled');
  });

  it('数据库拒绝跨 Session 的 Turn 所有权', () => {
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-b', 'Session B', 1, 1)
    `).run();

    expect(() => journal.prepare({
      callId: asToolCallId('call-cross-session'),
      sessionId: asSessionId('session-b'),
      turnId: asTurnId('turn-a'),
      toolName: 'read_file',
      input: { path: 'a.txt' },
    })).toThrow(/ownership_violation/);
  });
});
