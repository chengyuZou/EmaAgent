import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database.js';
import { MemoryItemsRepo } from '../../repos/memory-items.js';
import { MemoryNodesRepo } from '../../repos/memory-nodes.js';
import type { MemoryEmbeddingPageCursor } from '../../repos/memory-embedding-page.js';

const MODEL = 'embedding-test';
const SPACE = 'space-test';
const EMBEDDING = Buffer.from(new Float32Array([1]).buffer);

describe('Memory embedding 复合游标分页', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
  });

  afterEach(() => {
    database.close();
  });

  it('不会遗漏同一 updated_at 下的 memory nodes', () => {
    const repo = new MemoryNodesRepo(database.sqlite);
    for (const id of ['node-c', 'node-a', 'node-b']) {
      repo.insert({
        id,
        label: id,
        nodeType: 'entity',
        description: id,
        embedding: EMBEDDING,
        embeddingProviderId: 'provider-test',
        embeddingModel: MODEL,
        embeddingDim: 1,
        embeddingNormalization: 'l2',
        embeddingRevision: 'provider-managed',
        embeddingSpaceId: SPACE,
        createdAt: 0,
      });
    }

    const first = repo.listEmbeddablePage(SPACE, undefined, 2);
    const second = repo.listEmbeddablePage(SPACE, nextCursor(first), 2);

    expect(first.map((row) => row.id)).toEqual(['node-a', 'node-b']);
    expect(second.map((row) => row.id)).toEqual(['node-c']);
  });

  it('不会遗漏同一 updated_at 下的 memory items', () => {
    const repo = new MemoryItemsRepo(database.sqlite);
    for (const id of ['item-c', 'item-a', 'item-b']) {
      repo.insert({
        id,
        kind: 'user',
        title: id,
        body: id,
        modes: ['chat'],
        embedding: EMBEDDING,
        embeddingProviderId: 'provider-test',
        embeddingModel: MODEL,
        embeddingDim: 1,
        embeddingNormalization: 'l2',
        embeddingRevision: 'provider-managed',
        embeddingSpaceId: SPACE,
        createdAt: 0,
      });
    }

    const first = repo.listEmbeddablePage(SPACE, undefined, 2);
    const second = repo.listEmbeddablePage(SPACE, nextCursor(first), 2);

    expect(first.map((row) => row.id)).toEqual(['item-a', 'item-b']);
    expect(second.map((row) => row.id)).toEqual(['item-c']);
  });
});

function nextCursor(rows: Array<{ updated_at: number; id: string }>): MemoryEmbeddingPageCursor {
  const last = rows.at(-1);
  if (!last) throw new Error('无法从空分页创建游标');
  return { updatedAt: last.updated_at, id: last.id };
}
