import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import {
  DocumentAssetCursorError,
  DocumentAssetRepo,
} from '../../repos/kb/document-asset.js';

describe('B-060 DocumentAsset 复合游标', () => {
  let database: Database;
  let repo: DocumentAssetRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    repo = new DocumentAssetRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('同毫秒记录跨多页时不遗漏且不重复', () => {
    for (const id of ['asset-a', 'asset-b', 'asset-c', 'asset-d', 'asset-e']) {
      insertAsset(repo, id, 1_000);
    }
    insertAsset(repo, 'asset-old', 999);

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = repo.listPaged({ cursor, limit: 2 });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(ids).toEqual([
      'asset-e', 'asset-d', 'asset-c',
      'asset-b', 'asset-a', 'asset-old',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('关键词过滤与复合游标组合后仍稳定分页', () => {
    for (const id of ['asset-a', 'asset-b', 'asset-c']) {
      insertAsset(repo, id, 1_000, `match-${id}`);
    }
    insertAsset(repo, 'asset-other', 1_000, 'other');

    const first = repo.listPaged({ keyword: 'match-', limit: 2 });
    const second = repo.listPaged({ cursor: first.nextCursor!, keyword: 'match-', limit: 2 });

    expect([...first.items, ...second.items].map((item) => item.id))
      .toEqual(['asset-c', 'asset-b', 'asset-a']);
    expect(second.nextCursor).toBeNull();
  });

  it('畸形或版本未知的 cursor 会明确失败', () => {
    expect(() => repo.listPaged({ cursor: 'not-a-cursor' }))
      .toThrow(DocumentAssetCursorError);

    const futureCursor = Buffer.from(JSON.stringify({ v: 2, a: 1, i: 'asset-a' }))
      .toString('base64url');
    expect(() => repo.listPaged({ cursor: futureCursor }))
      .toThrow('Invalid document asset cursor');
  });

  it('当前 KB Schema 安装复合排序索引', () => {
    const indexSql = database.sqlite.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_doc_assets_created'
    `).pluck().get() as string;

    expect(indexSql.replaceAll(/\s+/g, ' '))
      .toContain('document_assets(created_at DESC, id DESC)');
    expect(database.currentVersion()).toBe(1);
  });

  it('分批核对当前 KB 拥有的资源 ID，并保持输入顺序且去重', () => {
    const existingIds = Array.from({ length: 405 }, (_, index) => `asset-${index}`);
    for (const id of existingIds) insertAsset(repo, id, 1_000);

    expect(repo.findExistingIds([
      'asset-404',
      'foreign-asset',
      ...existingIds,
      'asset-404',
    ])).toEqual([
      'asset-404',
      ...existingIds.slice(0, 404),
    ]);
  });
});

function insertAsset(
  repo: DocumentAssetRepo,
  id: string,
  createdAt: number,
  fileName = `${id}.txt`,
): void {
  repo.insert({
    id,
    filePath: `files/${fileName}`,
    fileName,
    mimeType: 'text/plain',
    wordCount: 1,
    status: 'indexed',
    createdAt,
    updatedAt: createdAt,
  });
}
