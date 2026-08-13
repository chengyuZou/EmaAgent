// 测试 kb_ingest_tasks 的单进程队列语义：原子领取、进度、终态、取消与中断恢复。

import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { KbIngestTasksRepo } from '../../repos/kb/kb-ingest-tasks.js';

describe('KbIngestTasksRepo', () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(): KbIngestTasksRepo {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    return new KbIngestTasksRepo(database.sqlite);
  }

  function insert(repo: KbIngestTasksRepo, id: string, assetId = `asset-${id}`): void {
    repo.insert({ id, assetId, filePath: `/files/${assetId}/doc.txt`, fileName: 'doc.txt' });
  }

  it('insert/get/list 与 findLatestByAssetId', () => {
    const repo = setup();
    insert(repo, 't1');
    insert(repo, 't2');
    insert(repo, 't3', 'asset-t1');

    expect(repo.get('t1')).toMatchObject({ status: 'pending', assetId: 'asset-t1' });
    expect(repo.list().map((task) => task.id)).toEqual(['t3', 't2', 't1']);
    // 同一 asset 的最新任务排在最前
    expect(repo.findLatestByAssetId('asset-t1')?.id).toBe('t3');
  });

  it('startNext 原子领取最早的 pending，重复领取落空', () => {
    const repo = setup();
    insert(repo, 't1');
    insert(repo, 't2');

    const first = repo.startNext();
    expect(first?.id).toBe('t1');
    expect(first?.status).toBe('running');
    expect(first?.stage).toBe('validate');
    expect(repo.startNext()?.id).toBe('t2');
    expect(repo.startNext()).toBeUndefined();
  });

  it('updateProgress 只在 running 时推进并夹取 0..1', () => {
    const repo = setup();
    insert(repo, 't1');
    expect(repo.updateProgress('t1', 'embed', 0.5)).toBe(false);

    repo.startNext();
    expect(repo.updateProgress('t1', 'embed', 0.5)).toBe(true);
    expect(repo.get('t1')).toMatchObject({ stage: 'embed', progress: 0.5 });
    repo.updateProgress('t1', 'embed', 1.7);
    expect(repo.get('t1')?.progress).toBe(1);
  });

  it('complete/fail 只对 running 生效', () => {
    const repo = setup();
    insert(repo, 't1');
    expect(repo.complete('t1')).toBe(false);

    repo.startNext();
    expect(repo.complete('t1')).toBe(true);
    expect(repo.get('t1')?.status).toBe('completed');
    expect(repo.fail('t1', 'late')).toBe(false);
  });

  it('cancel 把 pending/running 置为 cancelled', () => {
    const repo = setup();
    insert(repo, 't1');
    expect(repo.cancel('t1')).toBe(true);
    expect(repo.get('t1')?.status).toBe('cancelled');
  });

  it('markRunningInterrupted 把幽灵 running 标 failed', () => {
    const repo = setup();
    insert(repo, 't1');
    repo.startNext();
    expect(repo.markRunningInterrupted()).toBe(1);
    expect(repo.get('t1')).toMatchObject({ status: 'failed' });
  });
});
