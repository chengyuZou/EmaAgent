import type { SqliteDb } from '../database.js';
import { segmentForFts } from '../zh-tokenizer.js';

export interface DocumentChunkRow {
  id:                string;
  asset_id:          string;
  text:              string;
  markdown:          string | null;
  block_kinds_json:  string;
  token_count:       number;
  page:              number | null;
  section_path_json: string;
  prev_id:           string | null;
  next_id:           string | null;
  mom_id:            string | null;
  mom_text:          string | null;
  embedding:         Buffer | null;
}

export interface DocumentChunkInsert {
  id:          string;
  assetId:     string;
  text:        string;
  markdown?:   string;
  blockKinds:  string[];
  tokenCount:  number;
  page?:       number;
  sectionPath: string[];
  prev?:       string;
  next?:       string;
  momId?:      string;
  momText?:    string;
}

export interface ChunkSearchHit { chunkId: string; score: number }

/** 供文档详情视图用的 chunk 摘要（不含 embedding BLOB）。 */
export interface ChunkSummary {
  id:           string;
  text:         string;
  markdown?:    string;
  tokenCount:   number;
  page?:        number;
  sectionPath:  string[];
  hasEmbedding: boolean;
}

export interface ChunkPage {
  items:      ChunkSummary[];
  nextCursor: number | null;
}

function rowToChunk(row: DocumentChunkRow) {
  return {
    id:          row.id,
    assetId:     row.asset_id,
    text:        row.text,
    markdown:    row.markdown ?? undefined,
    blockKinds:  JSON.parse(row.block_kinds_json) as string[],
    tokenCount:  row.token_count,
    page:        row.page ?? undefined,
    sectionPath: JSON.parse(row.section_path_json) as string[],
    prev:        row.prev_id ?? undefined,
    next:        row.next_id ?? undefined,
    momId:       row.mom_id ?? undefined,
    momText:     row.mom_text ?? undefined,
  };
}

function vecToBlob(vector: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i]!, i * 4);
  return buf;
}

function vectorNorm(vector: number[]): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Number.isFinite(squared) ? Math.sqrt(squared) : 0;
}

/** 直接读取 Float32 BLOB，避免为每个 chunk 分配 number[]。 */
function cosineFromBlob(query: number[], queryNorm: number, blob: Buffer): number {
  if (query.length === 0 || queryNorm === 0 || blob.byteLength !== query.length * 4) return 0;

  let dot = 0;
  let blobSquared = 0;
  for (let index = 0; index < query.length; index++) {
    const value = blob.readFloatLE(index * 4);
    if (!Number.isFinite(value)) return 0;
    dot += query[index]! * value;
    blobSquared += value * value;
  }

  const denominator = queryNorm * Math.sqrt(blobSquared);
  if (denominator === 0 || !Number.isFinite(denominator)) return 0;
  const score = dot / denominator;
  return Number.isFinite(score) ? score : 0;
}

/**
 * 固定容量最小堆，根节点始终是当前 Top-K 中最差的一项。
 * 同分时 chunkId 较小者优先，确保不同平台和扫描计划下结果一致。
 */
class ChunkTopKHeap {
  private readonly values: ChunkSearchHit[] = [];

  constructor(private readonly capacity: number) {}

  offer(hit: ChunkSearchHit): void {
    if (this.capacity <= 0) return;
    if (this.values.length < this.capacity) {
      this.values.push(hit);
      this.siftUp(this.values.length - 1);
      return;
    }
    if (compareHitQuality(hit, this.values[0]!) <= 0) return;

    this.values[0] = hit;
    this.siftDown(0);
  }

  toSortedArray(): ChunkSearchHit[] {
    return [...this.values].sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return compareChunkId(left.chunkId, right.chunkId);
    });
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareHitQuality(this.values[index]!, this.values[parent]!) >= 0) return;
      [this.values[index], this.values[parent]] = [this.values[parent]!, this.values[index]!];
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) return;

      let worseChild = left;
      if (
        right < this.values.length
        && compareHitQuality(this.values[right]!, this.values[left]!) < 0
      ) {
        worseChild = right;
      }
      if (compareHitQuality(this.values[worseChild]!, this.values[index]!) >= 0) return;

      [this.values[index], this.values[worseChild]] = [
        this.values[worseChild]!,
        this.values[index]!,
      ];
      index = worseChild;
    }
  }
}

/** 正数表示 left 更好，负数表示 left 更差。 */
function compareHitQuality(left: ChunkSearchHit, right: ChunkSearchHit): number {
  if (left.score !== right.score) return left.score > right.score ? 1 : -1;
  if (left.chunkId === right.chunkId) return 0;
  return left.chunkId < right.chunkId ? 1 : -1;
}

function compareChunkId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class DocumentChunkRepo {
  constructor(private readonly db: SqliteDb) {}

  insertMany(chunks: DocumentChunkInsert[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO document_chunks
         (id, asset_id, text, tokens, markdown, block_kinds_json, token_count, page, section_path_json, prev_id, next_id, mom_id, mom_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const c of chunks) {
        // tokens = jieba 分词文本；FTS trigger 复制此列，使 BM25 对整词中文打分。
        stmt.run(c.id, c.assetId, c.text, segmentForFts(c.text), c.markdown ?? null,
          JSON.stringify(c.blockKinds), c.tokenCount,
          c.page ?? null, JSON.stringify(c.sectionPath),
          c.prev ?? null, c.next ?? null,
          c.momId ?? null, c.momText ?? null);
      }
    })();
  }

  findByAsset(assetId: string): ReturnType<typeof rowToChunk>[] {
    const rows = this.db
      .prepare('SELECT * FROM document_chunks WHERE asset_id = ? ORDER BY id')
      .all(assetId) as DocumentChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * 单个 asset 的 cursor 分页 chunk 摘要（供文档详情视图用）。
   * 按插入顺序（rowid）排序；cursor = 上一页最后一条的 rowid。
   * 刻意不加载 embedding BLOB-只返回 hasEmbedding 标志-
   * 使大文档分页保持低开销。
   */
  findByAssetPaged(
    assetId: string,
    opts: { cursor?: number; limit?: number } = {},
  ): { items: ChunkSummary[]; nextCursor: number | null } {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const params: unknown[] = [assetId];
    let cursorSql = '';
    if (opts.cursor !== undefined) { cursorSql = 'AND rowid > ?'; params.push(opts.cursor); }

    const rows = this.db.prepare(`
      SELECT rowid AS _rowid, id, text, markdown, token_count, page, section_path_json,
             (embedding IS NOT NULL) AS has_embedding
      FROM   document_chunks
      WHERE  asset_id = ? ${cursorSql}
      ORDER  BY rowid
      LIMIT  ?
    `).all(...params, limit + 1) as Array<{
      _rowid: number; id: string; text: string; markdown: string | null;
      token_count: number; page: number | null; section_path_json: string; has_embedding: number;
    }>;

    const hasMore = rows.length > limit;
    const slice   = rows.slice(0, limit);
    const items: ChunkSummary[] = slice.map(r => ({
      id:           r.id,
      text:         r.text,
      markdown:     r.markdown ?? undefined,
      tokenCount:   r.token_count,
      page:         r.page ?? undefined,
      sectionPath:  JSON.parse(r.section_path_json) as string[],
      hasEmbedding: r.has_embedding === 1,
    }));
    return { items, nextCursor: hasMore ? slice[slice.length - 1]!._rowid : null };
  }

  findById(id: string): ReturnType<typeof rowToChunk> | undefined {
    const row = this.db
      .prepare('SELECT * FROM document_chunks WHERE id = ?')
      .get(id) as DocumentChunkRow | undefined;
    return row ? rowToChunk(row) : undefined;
  }

  storeEmbedding(id: string, vector: number[]): void {
    this.db
      .prepare('UPDATE document_chunks SET embedding = ? WHERE id = ?')
      .run(vecToBlob(vector), id);
  }

  /** FTS5 BM25 全文检索，通过 JOIN 做 scope 过滤。
   *
   * Query 与索引文本同样走 jieba 分词，使 2 字中文词能命中。
   * 每个 token 作为 FTS phrase 加引号，避免标点被误读为 FTS operator。
   */
  searchFts(
    query:    string,
    assetIds: string[] | undefined,   // undefined = 所有 KB；[] = 无
    topK:     number,
  ): ChunkSearchHit[] {
    if (!query.trim()) return [];
    if (assetIds && assetIds.length === 0) return [];

    // 用 jieba 对 query 分词（与索引同管线），去除每个 token 中的 FTS
    // operator 字符，然后下方将每个 token 作为 phrase 加引号。
    const terms = segmentForFts(query)
      .split(/\s+/)
      .map(t => t.replace(/"/g, '').trim())
      .filter(Boolean); // jieba 词可能 1-2 字；不再设 trigram 最小长度
    if (terms.length === 0) return [];
    const ftsQuery = terms.map(t => `"${t}"`).join(' OR ');

    const assetFilter = assetIds ? `AND fts.asset_id IN (${assetIds.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`
      SELECT fts.chunk_id, bm25(document_chunks_fts) AS score
      FROM   document_chunks_fts fts
      WHERE  document_chunks_fts MATCH ?
             ${assetFilter}
      ORDER  BY score
      LIMIT  ?
    `).all(ftsQuery, ...(assetIds ?? []), topK) as Array<{ chunk_id: string; score: number }>;

    // bm25() 返回负值（越小匹配越好）；取反使分数升序
    return rows.map(r => ({ chunkId: r.chunk_id, score: -r.score }));
  }

  /** 对已存储的 BLOB embedding 做余弦相似度检索，按 assetIds 过滤。 */
  searchByEmbedding(
    queryVec: number[],
    assetIds: string[] | undefined,   // undefined = 所有 KB；[] = 无
    topK:     number,
  ): ChunkSearchHit[] {
    if (assetIds && assetIds.length === 0) return [];
    const capacity = Number.isFinite(topK) ? Math.max(0, Math.trunc(topK)) : 0;
    if (capacity === 0) return [];

    const assetFilter = assetIds ? `AND dc.asset_id IN (${assetIds.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`
      SELECT dc.id, dc.embedding
      FROM   document_chunks dc
      WHERE  dc.embedding IS NOT NULL
             ${assetFilter}
    `).iterate(...(assetIds ?? [])) as IterableIterator<{ id: string; embedding: Buffer }>;

    const queryNorm = vectorNorm(queryVec);
    const heap = new ChunkTopKHeap(capacity);
    for (const row of rows) {
      heap.offer({
        chunkId: row.id,
        score: cosineFromBlob(queryVec, queryNorm, row.embedding),
      });
    }
    return heap.toSortedArray();
  }

  /** 加载所有非 stale 的已 embedding chunk，用于构建内存 HNSW 索引。
   *  仅返回 asset 的 ebd_stale = 0 且有 stored embedding 的 chunk。 */
  getAllEmbeddings(): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return this.db.prepare(`
      SELECT dc.id, dc.asset_id AS assetId, dc.embedding
      FROM   document_chunks dc
      JOIN   document_assets da ON da.id = dc.asset_id
      WHERE  dc.embedding IS NOT NULL
        AND  da.ebd_stale = 0
    `).all() as Array<{ id: string; assetId: string; embedding: Buffer }>;
  }

  deleteByAsset(assetId: string): void {
    this.db.prepare('DELETE FROM document_chunks WHERE asset_id = ?').run(assetId);
  }
}
