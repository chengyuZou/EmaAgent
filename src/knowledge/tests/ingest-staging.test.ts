// 测试 KB staging 落盘、indexing 残留接管重建与删除文档的 staged 清理。

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, KbIngestTasksRepo } from '@ema-agent/storage';
import { DocumentEventEmitter } from '../events/emitter.js';
import { ingest } from '../ingest/index.js';
import { IngestQueue } from '../ingest/queue.js';
import { stageIngestFile } from '../ingest/staging.js';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeStore } from '../store/index.js';
import type { DocumentAsset, DocumentChunk, DocumentPreview } from '../types.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-staging-'));
  tmpDirs.push(dir);
  return dir;
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('KB staging', () => {
  it('入队时复制原文进 KB 目录，源文件删除后任务仍读取副本成功', async () => {
    const kbRoot = await makeTmpDir();
    const sourceDir = await makeTmpDir();
    const sourcePath = path.join(sourceDir, '季度报告.txt');
    await fsp.writeFile(sourcePath, '第一季度营收摘要', 'utf8');

    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    const seen: Array<{ filePath: string; stagedRelativePath?: string; content: string }> = [];
    const queue = new IngestQueue({
      tasks,
      ingest: async (filePath, options) => {
        seen.push({
          filePath,
          stagedRelativePath: options.stagedRelativePath,
          content: await fsp.readFile(filePath, 'utf8'),
        });
        return completedResult(options.assetId!);
      },
      resolveOptions: () => ({}),
      stageFile: (src, assetId) => stageIngestFile(kbRoot, assetId, src),
      concurrency: 1,
    });

    const task = await queue.enqueue({
      assetId: 'asset-1',
      filePath: sourcePath,
      fileName: '季度报告.txt',
      mimeType: 'text/plain',
    });

    // 入队后立即删除源文件——staging 保证任务不受影响。
    await fsp.rm(sourcePath);
    await waitUntil(() => tasks.get(task.id) === undefined);

    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.filePath).toBe(path.join(kbRoot, 'files', 'asset-1', '季度报告.txt'));
    expect(call.stagedRelativePath).toBe('files/asset-1/季度报告.txt');
    expect(call.content).toBe('第一季度营收摘要');
    database.close();
  });

  it('staging 失败时入队直接报错，不产生必失败的任务', async () => {
    const kbRoot = await makeTmpDir();
    const database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    const tasks = new KbIngestTasksRepo(database.sqlite);
    const queue = new IngestQueue({
      tasks,
      ingest: vi.fn(),
      resolveOptions: () => ({}),
      stageFile: (src, assetId) => stageIngestFile(kbRoot, assetId, src),
      concurrency: 1,
    });

    await expect(queue.enqueue({
      assetId: 'asset-missing',
      filePath: path.join(kbRoot, '不存在的文件.pdf'),
      fileName: '不存在的文件.pdf',
    })).rejects.toThrow();
    database.close();
  });
});

describe('indexing 残留接管', () => {
  it('asset 残留 indexing 状态时重跑直接接管重建，不再抛错', async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, 'doc.txt');
    await fsp.writeFile(filePath, '重建后的内容', 'utf8');

    const store = new InMemoryIngestStore();
    store.asset = {
      id: 'asset-crash',
      filePath: 'files/asset-crash/doc.txt',
      fileName: 'doc.txt',
      mimeType: 'text/plain',
      title: undefined,
      wordCount: 0,
      pageCount: undefined,
      contentHash: 'old-hash',
      status: 'indexing',
      createdAt: 1,
      updatedAt: 1,
      useCount: 0,
      lastActivatedAt: undefined,
    };

    const result = await ingest(
      filePath,
      { assetId: 'asset-crash' },
      { store: store as unknown as KnowledgeStore, events: new DocumentEventEmitter() },
    );

    expect(result.outcome).toBe('completed');
    expect(store.asset?.status).toBe('indexed');
    expect(store.asset?.id).toBe('asset-crash');
  });
});

describe('删除文档清理', () => {
  it('deleteAsset 同步删除 files/ 下的 staged 目录', async () => {
    const kbRoot = await makeTmpDir();
    const stagedDir = path.join(kbRoot, 'files', 'asset-9');
    await fsp.mkdir(stagedDir, { recursive: true });
    await fsp.writeFile(path.join(stagedDir, 'doc.txt'), 'staged', 'utf8');

    const store = {
      deleteAsset: vi.fn(),
    };
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
      kbRoot,
    });

    await client.deleteAsset('asset-9');

    expect(store.deleteAsset).toHaveBeenCalledWith('asset-9');
    expect(fs.existsSync(stagedDir)).toBe(false);
  });
});

class InMemoryIngestStore {
  asset?: DocumentAsset;
  chunks: DocumentChunk[] = [];
  preview?: DocumentPreview;

  getAsset(id: string): DocumentAsset | undefined {
    return this.asset?.id === id ? this.asset : undefined;
  }

  findAssetByHash(): DocumentAsset | undefined {
    return undefined;
  }

  addAsset(asset: DocumentAsset): void {
    this.asset = asset;
  }

  deleteAsset(): void {
    this.asset = undefined;
    this.chunks = [];
    this.preview = undefined;
  }

  patchAssetMeta(_id: string, meta: Partial<DocumentAsset>): void {
    if (this.asset) this.asset = { ...this.asset, ...meta };
  }

  updateStatus(_id: string, status: DocumentAsset['status']): void {
    if (this.asset) this.asset = { ...this.asset, status };
  }

  addChunks(chunks: DocumentChunk[]): void {
    this.chunks.push(...chunks);
  }

  storeEmbedding(): void {}

  setEmbeddingSpace(): void {}

  addPreview(preview: DocumentPreview): void {
    this.preview = preview;
  }
}

function completedResult(assetId: string) {
  return {
    asset: { id: assetId } as DocumentAsset,
    chunks: 0,
    preview: { assetId, text: '', wordCount: 0 } as DocumentPreview,
    outcome: 'completed' as const,
    counts: { total: 0, completed: 0, failed: 0 },
    failureShards: [],
  };
}
