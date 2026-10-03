// 验证稳定身份、多次 Run、事务回滚、忙碌拒绝和终态配置同步.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, SubagentsRepo, SubagentRunsRepo } from '@ema-agent/storage';
import { SubagentStore } from '../subagents/subagentStore.js';

describe('SubagentStore', () => {
  let database: Database;
  let store: SubagentStore;
  const completion = { iterations: 2, toolCallCount: 1, inputTokens: 10, outputTokens: 5, finalText: '结果' };
  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare("INSERT INTO sessions (id,title,cwd,created_at,updated_at) VALUES ('s','会话','',1,1)").run();
    store = new SubagentStore(database.sqlite, new SubagentsRepo(database.sqlite), new SubagentRunsRepo(database.sqlite));
    store.start({
      subagentId: 'child', runId: 'r1', toolCallId: 'call1', sessionId: 's',
      title: '查接口', description: '检查接口约束', contextMode: 'fork', isNew: true,
    });
  });
  afterEach(() => database.close());

  it('首个 Run 插入失败时身份也回滚', () => {
    expect(() => store.start({
      subagentId: 'orphan', runId: 'r2', toolCallId: 'call1', sessionId: 's',
      title: '重复', description: '重复工具调用', contextMode: 'subagent', isNew: true,
    })).toThrow();
    expect(store.get('orphan')).toBeUndefined();
  });

  it('忙碌不修改身份; 完成后继续只新增 Run, 不重建身份', () => {
    expect(() => store.start({
      subagentId: 'child', runId: 'busy', toolCallId: 'busyCall', sessionId: 's',
      title: '不该修改', contextMode: 'fork', isNew: false,
    })).toThrow('正在被占用');
    expect(store.get('child')?.title).toBe('查接口');
    store.complete('r1', completion);
    const createdAt = store.get('child')!.createdAt;
    store.start({
      subagentId: 'child', runId: 'r2', toolCallId: 'call2', sessionId: 's',
      contextMode: 'fork', isNew: false,
    });
    expect(store.get('child')).toMatchObject({ title: '查接口', description: '检查接口约束', status: 'running', createdAt });
    expect(store.listRuns('child').items).toHaveLength(2);
    expect(store.getRun('r1')).toMatchObject({ status: 'completed', finalText: '结果' });
    expect(() => store.complete('r1', completion)).toThrow('无法完成');
    expect(store.get('child')?.status).toBe('running');
  });

  it('准备成功才同步身份实际配置, 本次统计只在 Run 上', () => {
    store.setConfiguration('r1', {
      providerId: 'p', modelId: 'm', protocol: 'openai-chat', permissionMode: 'acceptEdits', reasoningEffort: 'high',
    });
    store.complete('r1', completion);
    expect(store.get('child')).toMatchObject({ providerId: 'p', modelId: 'm', permissionMode: 'acceptEdits', reasoningEffort: 'high', status: 'completed' });
    expect(store.get('child')).not.toHaveProperty('inputTokens');
    expect(store.getRun('r1')).toMatchObject({ ...completion, completedAt: expect.any(Number) });
  });

  it.each(['fail', 'cancel'] as const)('%s 按 Run 收口并同步身份状态', method => {
    store[method]('r1', '原因');
    expect(store.getRun('r1')).toMatchObject({ error: '原因', status: method === 'fail' ? 'failed' : 'cancelled' });
    expect(store.get('child')?.status).toBe(method === 'fail' ? 'failed' : 'cancelled');
  });

  it('重启恢复只将残留 Run 标为失败, 不创建新 Run', () => {
    expect(store.recoverInterrupted()).toMatchObject([{ id: 'r1', status: 'failed' }]);
    expect(store.get('child')?.status).toBe('failed');
    expect(store.listRuns('child').items).toHaveLength(1);
    expect(store.recoverInterrupted()).toEqual([]);
  });
});
