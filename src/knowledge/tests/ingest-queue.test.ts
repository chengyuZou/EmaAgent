import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, KbIngestTasksRepo } from '@ema-agent/storage';
import type { IngestOptions, IngestResult } from '../types.js';
import { IngestQueue } from '../ingest/queue.js';

describe('B-011/B-012 IngestQueue', () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('首次导入记录失败分片，重试只处理失败 chunk', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    const calls: IngestOptions[] = [];
    const ingest = vi.fn(async (_filePath: string, options: IngestOptions) => {
      calls.push(options);
      return calls.length === 1
        ? partialResult(options.assetId!)
        : completedResult(options.assetId!);
    });
    const queue = new IngestQueue({
      tasks,
      ingest,
      resolveOptions: () => ({ ebdProviderId: 'provider-1', ebdModel: 'embed-1' }),
      concurrency: 1,
    });

    const task = await queue.enqueue({
      assetId: 'asset-1',
      filePath: 'D:/docs/one.md',
      fileName: 'one.md',
      mimeType: 'text/markdown',
    });
    expect(task.id).not.toBe(task.assetId);

    await waitUntil(() => tasks.get(task.id)?.status === 'partial_failed');
    expect(tasks.listFailures(task.id).flatMap(failure => failure.itemIds))
      .toEqual(['chunk-b', 'chunk-c']);
    expect(calls[0]).toMatchObject({
      assetId: 'asset-1',
      taskId: task.id,
      attempt: 1,
    });
    expect(calls[0]!.retryChunkIds).toBeUndefined();

    expect(queue.retry(task.id)).toBe(true);
    await waitUntil(() => tasks.get(task.id) === undefined);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      assetId: 'asset-1',
      taskId: task.id,
      attempt: 2,
      retryChunkIds: ['chunk-b', 'chunk-c'],
    });
  });

  it('页级解析失败重试会替换整份文档，而不是误走 chunk 重试', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    const calls: IngestOptions[] = [];
    const queue = new IngestQueue({
      tasks,
      ingest: async (_filePath, options) => {
        calls.push(options);
        return calls.length === 1
          ? parsePartialResult(options.assetId!)
          : completedResult(options.assetId!);
      },
      resolveOptions: () => ({ visionProviderId: 'vision-1', visionModel: 'ocr-1' }),
      concurrency: 1,
    });

    const task = await queue.enqueue({
      assetId: 'asset-pdf',
      filePath: 'D:/docs/large.pdf',
      fileName: 'large.pdf',
      mimeType: 'application/pdf',
    });
    await waitUntil(() => tasks.get(task.id)?.status === 'partial_failed');

    expect(queue.retry(task.id)).toBe(true);
    await waitUntil(() => tasks.get(task.id) === undefined);
    expect(calls[1]).toMatchObject({
      taskId: task.id,
      attempt: 2,
      replaceExistingAsset: true,
    });
    expect(calls[1]!.retryChunkIds).toBeUndefined();
  });
});

function partialResult(assetId: string): IngestResult {
  return {
    ...baseResult(assetId),
    outcome: 'partial_failed',
    counts: { total: 3, completed: 1, failed: 2 },
    failureShards: [{
      stage: 'embed',
      shardKey: 'embed:0',
      itemIds: ['chunk-b', 'chunk-c'],
      retryable: true,
      errorCode: 'kb/embed-batch-failed',
      error: 'provider unavailable',
    }],
  };
}

function completedResult(assetId: string): IngestResult {
  return {
    ...baseResult(assetId),
    outcome: 'completed',
    counts: { total: 3, completed: 3, failed: 0 },
    failureShards: [],
  };
}

function parsePartialResult(assetId: string): IngestResult {
  return {
    ...baseResult(assetId),
    outcome: 'partial_failed',
    counts: { total: 5, completed: 4, failed: 1 },
    failureShards: [{
      stage: 'parse',
      shardKey: 'parse:page:30',
      itemIds: ['30'],
      retryable: true,
      errorCode: 'vision/provider-unavailable',
      error: 'OCR provider unavailable',
    }],
  };
}

function baseResult(assetId: string): Pick<IngestResult, 'asset' | 'chunks' | 'preview'> {
  return {
    asset: {
      id: assetId,
      filePath: 'D:/docs/one.md',
      fileName: 'one.md',
      mimeType: 'text/markdown',
      wordCount: 3,
      status: 'indexed',
      createdAt: 1,
      updatedAt: 1,
      useCount: 0,
    },
    chunks: 3,
    preview: { assetId, text: 'preview', wordCount: 3 },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待异步队列状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
