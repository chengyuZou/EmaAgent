import { randomUUID }  from 'node:crypto';
import fs              from 'node:fs/promises';
import path            from 'node:path';
import {
  Database,
  DocumentAssetRepo, DocumentChunkRepo, DocumentPreviewRepo,
  KbActivationsRepo, KbIngestTasksRepo, KbReembedTasksRepo,
  type KbRecord,
} from '@ema-agent/storage';
import type { KbRegistryRepo }   from '@ema-agent/storage';
import type { EmbedRuntime }     from '@ema-agent/embed';
import type { RerankRuntime }    from '@ema-agent/rerank';
import { KnowledgeClient }       from './client.js';
import { KnowledgeStore }        from './store/index.js';
import { IngestQueue }           from './ingest/queue.js';
import { stageIngestFile }       from './ingest/staging.js';
import { ReembedQueue }          from './reembed/queue.js';
import { DocumentEventEmitter }  from './events/emitter.js';
import type { KbVisionAdapter }  from './adapters/vision.js';
import type { IngestOptions, SearchOptions, KbSearchResult } from './types.js';
import { applyResultBudget } from './retrieval/resultBudget.js';
import {
  DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS,
  type KnowledgeRetrievalSettings,
} from './settings.js';

// ── Entry ─────────────────────────────────────────────────────────────────────

/** One open KB: its database, client (with HNSW), and ingest queue. */
export interface KbEntry {
  readonly db:           Database;
  readonly client:       KnowledgeClient;
  readonly ingestTasks:  KbIngestTasksRepo;
  readonly ingestQueue:  IngestQueue;
  readonly reembedTasks: KbReembedTasksRepo;
  readonly reembedQueue: ReembedQueue;
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface KbManagerDeps {
  registry:             KbRegistryRepo;
  activations:          KbActivationsRepo;
  embedRuntime?:        EmbedRuntime;
  rerankRuntime?:       RerankRuntime;
  visionAdapter?:       KbVisionAdapter;
  resolveIngestOptions: () => Partial<IngestOptions>;
  /** 每次检索操作时读取用户可调的检索参数；缺省用内置默认值。 */
  resolveRetrievalSettings?: () => KnowledgeRetrievalSettings;
  concurrency?:         number;
}

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * Manages a registry of named knowledge bases (profile.db.knowledge_bases).
 * Each KB is a self-contained folder: {kb.path}/kb.db + {kb.path}/files/.
 * Clients (KnowledgeClient + HNSW index) are opened lazily and cached.
 */
export class KbManager {
  /** Aggregated event bus — all per-KB DocumentProgressEvents flow through here.
   *  bindings.ts bridges this to the system-bus SSE with kbId injected. */
  readonly events = new DocumentEventEmitter();

  private readonly cache = new Map<string, KbEntry>();

  constructor(private readonly deps: KbManagerDeps) {}

  // ── Registry operations ───────────────────────────────────────────────────

  listKbs(): KbRecord[]                { return this.deps.registry.list(); }
  getKb(id: string)                    { return this.deps.registry.get(id); }
  getActiveKb(): KbRecord | undefined  { return this.deps.registry.getActive(); }
  renameKb(id: string, name: string)   { this.deps.registry.rename(id, name); }
  setActiveKb(id: string)              { this.deps.registry.setActive(id); }

  /** Remove KB from registry only — does NOT delete files from disk. */
  unregisterKb(id: string): void {
    this.cache.get(id)?.db.close();
    this.cache.delete(id);
    this.deps.registry.delete(id);
  }

  // ── KB creation ───────────────────────────────────────────────────────────

  /**
   * Create a new named KB: mkdir + open/migrate kb.db + register in profile.db.
   * The new KB starts inactive; call setActiveKb() to activate it.
   */
  async createKb(name: string, kbPath: string): Promise<KbRecord> {
    await fs.mkdir(path.join(kbPath, 'files'), { recursive: true });
    const id = randomUUID();
    this.deps.registry.insert({ id, name, path: kbPath });
    await this.openEntry({ id, name, path: kbPath, isActive: false, createdAt: Date.now(), updatedAt: Date.now() });
    return this.deps.registry.get(id)!;
  }

  // ── Client access (lazy open) ─────────────────────────────────────────────

  async openClient(kbId: string): Promise<KbEntry> {
    const cached = this.cache.get(kbId);
    if (cached) return cached;
    const rec = this.deps.registry.get(kbId);
    if (!rec) throw new Error(`[kb-manager] KB not found: ${kbId}`);
    return this.openEntry(rec);
  }

  /** Returns undefined when no KB is marked active. */
  async openActiveEntry(): Promise<KbEntry | undefined> {
    const active = this.deps.registry.getActive();
    if (!active) return undefined;
    return this.openClient(active.id);
  }

  // ── Search (multi-KB, active-KB, or per-turn scope) ───────────────────────

  /**
   * Search one or more KBs.
   *   kbIds = [] → search the active KB
   *   kbIds = [id1, id2] → search those KBs and merge results by score
   *
   * opts.assetScopes lets the caller supply per-KB document filters (from the chat picker).
   * Each KB only sees the assetIds that belong to it; KBs without a matching scope are
   * searched without a doc filter. This also fixes the activation recording bug: each
   * KB's client.search() receives the correct assetIds and calls recordActivation().
   */
  async search(kbIds: string[], query: string, opts: SearchOptions = {}): Promise<KbSearchResult> {
    const active    = this.deps.registry.getActive();
    const targetIds = kbIds.length > 0 ? kbIds : (active ? [active.id] : []);

    if (targetIds.length === 0) return { query, hits: [] };

    const retrieval = this.deps.resolveRetrievalSettings?.()
      ?? DEFAULT_KNOWLEDGE_RETRIEVAL_SETTINGS;
    const effectiveTopK = opts.topK ?? retrieval.defaultTopK;
    // maxResultChars 只由调用方显式指定，在合并后统一填充一次；
    // 各 KB 内部不按预算截断，避免多 KB 结果叠加超限。
    const { assetScopes, assetIds: _ignored, maxResultChars, ...restOpts } = opts;
    const sharedOpts = {
      ...restOpts,
      topK: effectiveTopK,
      alpha: opts.alpha ?? retrieval.alpha,
      rerankBlendWeight: opts.rerankBlendWeight ?? retrieval.rerankBlendWeight,
    };

    const settled = await Promise.allSettled(
      targetIds.map(async (id) => {
        const entry = await this.openClient(id);
        const scope = assetScopes?.find((s) => s.kbId === id);
        return entry.client.search(query, { ...sharedOpts, assetIds: scope?.assetIds });
      }),
    );

    const hits = settled
      .filter((r): r is PromiseFulfilledResult<KbSearchResult> => r.status === 'fulfilled')
      .flatMap((r) => r.value.hits)
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveTopK);

    return { query, hits: applyResultBudget(hits, maxResultChars) };
  }

  // ── Embedding model invalidation ───────────────────────────────────────────

  /**
   * embed 模型绑定变更后调用：对每个已注册 KB 标记异空间向量为 stale 并清掉
   * 内存索引。单个 KB 失败不中断整场——失败的 KB 返回在 failedKbIds 中，
   * 下次打开或搜索时 ensureIndex 仍会惰性补标。
   */
  async invalidateAllEmbeddings(newSpaceId: string): Promise<{
    kbCount: number;
    markedStale: number;
    failedKbIds: string[];
  }> {
    const records = this.deps.registry.list();
    let markedStale = 0;
    const failedKbIds: string[] = [];
    for (const rec of records) {
      try {
        const entry = await this.openClient(rec.id);
        markedStale += entry.client.invalidateEmbeddings(newSpaceId);
      } catch (err) {
        console.warn(`[kb-manager] invalidate embeddings failed for KB "${rec.name}":`, err);
        failedKbIds.push(rec.id);
      }
    }
    return { kbCount: records.length, markedStale, failedKbIds };
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Ensure at least one KB exists. If the registry is empty, auto-create a
   * default KB at `defaultPath` and mark it active. Called at startup.
   */
  async ensureDefault(defaultPath: string): Promise<void> {
    if (this.deps.registry.list().length > 0) return;
    const created = await this.createKb('默认知识库', defaultPath);
    this.deps.registry.setActive(created.id);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async openEntry(rec: KbRecord): Promise<KbEntry> {
    const dbPath = path.join(rec.path, 'kb.db');
    const db = new Database({ path: dbPath, kind: 'kb' });
    db.migrate();

    const store = new KnowledgeStore(
      new DocumentAssetRepo(db.sqlite),
      new DocumentChunkRepo(db.sqlite),
      new DocumentPreviewRepo(db.sqlite),
      this.deps.activations,
      rec.id,
    );

    const client = new KnowledgeClient({
      store,
      embedRuntime:  this.deps.embedRuntime,
      rerankRuntime: this.deps.rerankRuntime,
      visionAdapter: this.deps.visionAdapter,
      kbRoot:        rec.path,
    });

    const ingestTasks = new KbIngestTasksRepo(db.sqlite);
    const ingestQueue = new IngestQueue({
      tasks:          ingestTasks,
      ingest:         (fp, opts) => client.ingest(fp, opts),
      resolveOptions: this.deps.resolveIngestOptions,
      stageFile:      (sourcePath, assetId) => stageIngestFile(rec.path, assetId, sourcePath),
      concurrency:    this.deps.concurrency ?? 3,
    });

    const reembedTasks = new KbReembedTasksRepo(db.sqlite);
    const reembedQueue = new ReembedQueue({
      tasks:  reembedTasks,
      sweep:  (input) => client.reembedSweep(input),
      events: client.events,
    });

    const entry: KbEntry = { db, client, ingestTasks, ingestQueue, reembedTasks, reembedQueue };
    this.cache.set(rec.id, entry);

    // Wire this KB's events → aggregated bus + persist task progress in kb.db.
    // Inject kbId so consumers (bindings SSE bridge, frontend) can identify the source KB.
    // reembed 事件的进度由 ReembedQueue 自己持久化, 不写 ingest 任务表。
    client.events.on((e) => {
      if (
        e.operation !== 'reembed'
        && e.kind !== 'complete'
        && e.kind !== 'partial_failed'
        && e.kind !== 'error'
        && e.taskId
        && e.attempt !== undefined
      ) {
        const base: Record<string, number> = { validate: 0.05, parse: 0.25, chunk: 0.45, embed: 0.5 };
        const progress = e.kind === 'embed' ? 0.5 + 0.5 * (e.progress ?? 0) : (base[e.kind] ?? 0);
        ingestTasks.updateProgress(e.taskId, e.attempt, e.kind, progress);
      }
      this.events.emit({ ...e, kbId: rec.id });
    });

    // HNSW init (fire-and-forget; falls back to SQL cosine until done).
    void client.init().catch((err) => {
      console.warn(`[kb-manager] HNSW init failed for KB "${rec.name}":`, err);
    });

    ingestQueue.resume();
    reembedQueue.resume();
    return entry;
  }
}
