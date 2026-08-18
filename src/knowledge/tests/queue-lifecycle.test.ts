// 测试队列生命周期行为：重试防连点、reembed 部分失败终态可重试、shutdown 落定。

import { describe, expect, it, vi } from 'vitest';
import { Database, KbIngestTasksRepo, KbReembedTasksRepo } from '@ema-agent/storage';
import { IngestQueue } from '../ingest/queue.js';
import { ReembedQueue } from '../reembed/queue.js';
import type { IngestResult } from '../types.js';
import type { KnowledgeEmbeddingSelection } from '../types.js';

/** 重嵌目标模型统一为当前绑定；测试里用固定 selection 模拟装配层注入。 */
const EMBED_SELECTION: KnowledgeEmbeddingSelection = {
  providerId: 'p',
  model: 'm',
  embedding: { embed: async () => ({ embeddings: [], dim: 0 }) } as never,
};

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('IngestQueue 重试防连点', () => {
  it('同一资产已有在途任务时 retry 返回 undefined', () => {
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    tasks.insert({ id: 't1-failed', assetId: 'asset-1', filePath: '/f', fileName: 'f' });
    tasks.startNext();
    tasks.fail('t1-failed', 'boom');
    // 同资产更新的 pending 任务（连点/外部重入产生）
    tasks.insert({ id: 't2-pending', assetId: 'asset-1', filePath: '/f', fileName: 'f' });

    const queue = new IngestQueue({
      kbId: 'kb-1',
      tasks,
      ingest: vi.fn(),
      stageFile: vi.fn(),
      emit: () => {},
      concurrency: 1,
    });

    expect(queue.retry('t1-failed')).toBeUndefined();
    database.close();
  });
});

describe('ReembedQueue 单行失败', () => {
  it('执行抛错时任务标 failed、retry 生成同资产新行', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbReembedTasksRepo(database.sqlite);
    const events: string[] = [];
    const queue = new ReembedQueue({
      kbId: 'kb-1',
      tasks,
      reembed: async () => { throw new Error('provider 500'); },
      emit: (event) => events.push(event.type),
    });

    const task = queue.enqueue({ assetId: 'asset-bad', embedding: EMBED_SELECTION });
    await waitUntil(() => tasks.get(task.id)?.status === 'failed');

    expect(tasks.get(task.id)?.error).toContain('provider 500');
    expect(events).toContain('kb_reembed_failed');
    expect(events).not.toContain('kb_reembed_completed');
    const retried = queue.retry(task.id, EMBED_SELECTION);
    expect(retried?.id).not.toBe(task.id);
    expect(retried?.assetId).toBe('asset-bad');
    await queue.shutdown();
    database.close();
  });

  it('同资产有在途任务时拒绝重复入队', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbReembedTasksRepo(database.sqlite);
    const queue = new ReembedQueue({
      kbId: 'kb-1',
      tasks,
      reembed: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); },
      emit: () => {},
    });

    const task = queue.enqueue({ assetId: 'asset-1', embedding: EMBED_SELECTION });
    await waitUntil(() => tasks.get(task.id)?.status === 'running');
    expect(() => queue.enqueue({ assetId: 'asset-1', embedding: EMBED_SELECTION }))
      .toThrow('该文档已有重嵌任务进行中');
    // 别的资产不受影响。
    expect(() => queue.enqueue({ assetId: 'asset-2', embedding: EMBED_SELECTION }))
      .not.toThrow();
    await queue.shutdown();
    database.close();
  });
});

describe('ReembedQueue 并发', () => {
  it('两个任务并行在途（峰值并发=2）', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbReembedTasksRepo(database.sqlite);
    let inFlight = 0;
    let peak = 0;
    const queue = new ReembedQueue({
      kbId: 'kb-1',
      tasks,
      reembed: async ({ onProgress }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight--;
        onProgress(1, 1);
      },
      emit: () => {},
    });

    const first = queue.enqueue({ assetId: 'asset-1', embedding: EMBED_SELECTION });
    const second = queue.enqueue({ assetId: 'asset-2', embedding: EMBED_SELECTION });
    await waitUntil(() =>
      tasks.get(first.id)?.status === 'completed'
      && tasks.get(second.id)?.status === 'completed');

    expect(peak).toBe(2);
    database.close();
  });
});

describe('IngestQueue shutdown', () => {
  it('中止在途任务并等待落定，终态写入发生在关库之前', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    const queue = new IngestQueue({
      kbId: 'kb-1',
      tasks,
      ingest: (_filePath, options) => new Promise<IngestResult>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
      stageFile: async () => ({ absolutePath: '/f', relativePath: 'files/asset-1/f' }),
      emit: () => {},
      concurrency: 1,
    });

    await queue.enqueue({ assetId: 'asset-1', filePath: '/f', fileName: 'f' });
    await waitUntil(() => tasks.list().some((task) => task.status === 'running'));
    await queue.shutdown();

    // abort 使任务以 failed 落定（写入发生在连接仍打开时）。
    expect(tasks.list()[0]?.status).toBe('failed');
    expect(tasks.list()[0]?.error).toContain('知识库已关闭');
    database.close();
  });
});
