// 测试 kb_reembed_tasks 的单进程队列语义：原子领取、终态、取消与中断恢复。

import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { KbReembedTasksRepo } from '../../repos/kb/kb-reembed-tasks.js';

describe('KbReembedTasksRepo', () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(): KbReembedTasksRepo {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    return new KbReembedTasksRepo(database.sqlite);
  }

  it('insert/get/list 带冻结的 embedding 身份', () => {
    const repo = setup();
    repo.insert({ id: 't1', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });
    expect(repo.get('t1')).toMatchObject({
      status: 'pending',
      embeddingProviderConfigId: 'p1',
      embeddingModel: 'm1',
    });
    expect(repo.list().map((task) => task.id)).toEqual(['t1']);
  });

  it('startNext 原子领取最早的 pending，重复领取落空', () => {
    const repo = setup();
    repo.insert({ id: 't1', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });
    repo.insert({ id: 't2', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });

    const first = repo.startNext();
    expect(first?.id).toBe('t1');
    expect(first?.status).toBe('running');
    expect(repo.startNext()?.id).toBe('t2');
  });

  it('complete/fail 只对 running 生效', () => {
    const repo = setup();
    repo.insert({ id: 't1', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });
    expect(repo.complete('t1')).toBe(false);

    repo.startNext();
    expect(repo.complete('t1')).toBe(true);
    expect(repo.get('t1')?.status).toBe('completed');
    expect(repo.fail('t1', 'late')).toBe(false);
  });

  it('cancel 把 pending/running 置为 cancelled', () => {
    const repo = setup();
    repo.insert({ id: 't1', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });
    expect(repo.cancel('t1')).toBe(true);
    expect(repo.get('t1')?.status).toBe('cancelled');
  });

  it('markRunningInterrupted 把幽灵 running 标 failed', () => {
    const repo = setup();
    repo.insert({ id: 't1', embeddingProviderConfigId: 'p1', embeddingModel: 'm1' });
    repo.startNext();
    expect(repo.markRunningInterrupted()).toBe(1);
    expect(repo.get('t1')).toMatchObject({ status: 'failed' });
  });
});
