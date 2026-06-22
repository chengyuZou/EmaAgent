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

function blobToVec(blob: Buffer): number[] {
  const len = blob.byteLength / 4;
  const out: number[] = new Array(len);
  for (let i = 0; i < len; i++) out[i] = blob.readFloatLE(i * 4);
  return out;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
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
        // tokens = jieba-segmented text; the FTS trigger copies this column so
        // BM25 scores over whole Chinese words (migration 009).
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

  /** FTS5 BM25 full-text search, scope-filtered via JOIN.
   *
   * Uses jieba word-segmented index (migration 009): the query is segmented the
   * same way as the indexed text, so 2-char Chinese words match (which trigram's
   * 3-char window could not). Each token is quoted as an FTS phrase so input
   * punctuation can't be misread as an FTS operator.
   */
  searchFts(
    query:    string,
    assetIds: string[] | undefined,   // undefined = all KBs; [] = none
    topK:     number,
  ): ChunkSearchHit[] {
    if (!query.trim()) return [];
    if (assetIds && assetIds.length === 0) return [];

    // Segment the query with jieba (same pipeline as indexing), strip any FTS
    // operator chars from each token, then quote each as a phrase below.
    const terms = segmentForFts(query)
      .split(/\s+/)
      .map(t => t.replace(/"/g, '').trim())
      .filter(Boolean); // jieba words can be 1–2 chars; no trigram length floor anymore
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

    // bm25() returns negative values (lower = better match); negate for ascending scores
    return rows.map(r => ({ chunkId: r.chunk_id, score: -r.score }));
  }

  /** Cosine similarity search over stored BLOB embeddings, filtered to assetIds. */
  searchByEmbedding(
    queryVec: number[],
    assetIds: string[] | undefined,   // undefined = all KBs; [] = none
    topK:     number,
  ): ChunkSearchHit[] {
    if (assetIds && assetIds.length === 0) return [];
    const assetFilter = assetIds ? `AND dc.asset_id IN (${assetIds.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`
      SELECT dc.id, dc.embedding
      FROM   document_chunks dc
      WHERE  dc.embedding IS NOT NULL
             ${assetFilter}
    `).all(...(assetIds ?? [])) as Array<{ id: string; embedding: Buffer }>;

    const hits = rows.map(r => ({
      chunkId: r.id,
      score:   cosine(queryVec, blobToVec(r.embedding)),
    }));

    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Load all non-stale embedded chunks for building the in-memory HNSW index.
   *  Only chunks whose asset has ebd_stale = 0 and a stored embedding are returned. */
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
