// 验证子代理终态写入不返回镜像结果, 相同终态可重复调用, 冲突终态会报错。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, SubagentsRepo } from '@ema-agent/storage';
import { SubagentStore } from '../subagents/subagentStore.js';

describe('SubagentStore 终态', () => {
  let database: Database;
  let store: SubagentStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-1', 'Session', 'D:/work', 1, 1)
    `).run();
    database.sqlite.prepare(`
      INSERT INTO turns (id, session_id, status, created_at)
      VALUES ('turn-1', 'session-1', 'running', 1)
    `).run();
    store = new SubagentStore(new SubagentsRepo(database.sqlite));
    store.start({
      subagentId: 'subagent-1',
      sessionId: 'session-1',
      parentTurnId: 'turn-1',
      contextMode: 'subagent',
    });
  });

  afterEach(() => database.close());

  it('完成只写终态, 重复完成不覆盖首次结果', () => {
    const completion = {
      iterations: 2,
      toolCallCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      finalText: '首次结果',
    };
    expect(store.complete('subagent-1', completion)).toBeUndefined();
    expect(store.complete('subagent-1', { ...completion, finalText: '迟到结果' })).toBeUndefined();
    expect(store.get('subagent-1')).toMatchObject({
      status: 'completed',
      finalText: '首次结果',
    });
    expect(() => store.fail('subagent-1', '迟到失败')).toThrow('无法写入失败终态');
  });

  it('失败与取消各自保持原有的重复调用语义', () => {
    expect(store.fail('subagent-1', '模型错误')).toBeUndefined();
    expect(store.fail('subagent-1', '模型错误')).toBeUndefined();
    expect(() => store.fail('subagent-1', '另一错误')).toThrow('无法写入失败终态');
    expect(() => store.cancel('subagent-1', '用户取消')).toThrow('无法取消');

    store.start({
      subagentId: 'subagent-2',
      sessionId: 'session-1',
      parentTurnId: 'turn-1',
      contextMode: 'subagent',
    });
    expect(store.cancel('subagent-2', '用户取消')).toBeUndefined();
    expect(store.cancel('subagent-2', '重复取消')).toBeUndefined();
    expect(store.get('subagent-2')).toMatchObject({ status: 'cancelled', error: '用户取消' });
  });

  it('不存在的执行不能写入终态', () => {
    expect(() => store.complete('missing', {
      iterations: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      finalText: '',
    })).toThrow('Subagent missing 不存在');
  });
});
