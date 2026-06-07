/**
 * bench-deps.ts — Minimal MemoryDeps factory for bench runners.
 *
 * Wires the real production classes (SQLite repos, MemoryPlanner) against:
 *   - An in-memory SQLite Database (no disk I/O, discarded after each case).
 *   - A mock EbdRouter that serves vectors from the bench/cache/bge-m3.json
 *     disk cache instead of calling the SiliconFlow API.
 *   - Stub implementations for LlmRouter, NarrativeClient, SessionStore,
 *     and ModelBindingsRepo — none of these are exercised during plan().
 *
 * Usage:
 *   const bd = createBenchDeps(embedCache);
 *   // insert items, run planner …
 *   bd.close();   // frees the in-memory DB
 */

import crypto from 'node:crypto';
import {
  Database,
  MemoryItemsRepo,
  MemoryNodesRepo,
  MemoryEdgesRepo,
  MemoryLazyUpdatesRepo,
  SessionNotesRepo,
  BackgroundTasksRepo,
  SessionsRepo,
  ModelBindingsRepo,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../../src/deps.js';
import { EmbedCache, EMBED_DIM } from './siliconflow.js';
import { packEmbedding } from '../../src/embed/similarity.js';

export { packEmbedding };
export const BENCH_PROVIDER_ID = 'bench-bge-m3';
export const BENCH_MODEL       = 'Pro/BAAI/bge-m3';

// ── Mock EbdRouter ─────────────────────────────────────────────────────────────
//
// Returns vectors from the on-disk BGE-M3 cache.
// Throws if a text is not cached (caller must precompute first).
//
// We duck-type against EbdRouter — the bench imports it as unknown to avoid
// pulling in ebd-client's real adapter machinery.

function makeBenchEbdRouter(cache: EmbedCache): MemoryDeps['ebd'] {
  return {
    // ── identity queries (used by EmbedService + planner initialize) ─────────
    firstEmbedId:         ()  => BENCH_PROVIDER_ID,
    defaultEmbedModelFor: (id: string) => id === BENCH_PROVIDER_ID ? BENCH_MODEL : undefined,

    // ── embed ─────────────────────────────────────────────────────────────────
    embed: async ({ texts }: { texts: string[]; providerId: string; model: string }) => ({
      embeddings: texts.map(t => {
        const vec = cache.get(t);
        if (!vec) throw new Error(`bench-ebd: not cached — "${t.slice(0, 60)}"`);
        return vec;
      }),
      dim: EMBED_DIM,
    }),

    // ── stubs — not called during plan() ─────────────────────────────────────
    rerank:              async () => ({ results: [] }),
    upsertEmbedConfig:   () => {},
    removeEmbedConfig:   () => {},
    upsertRerankConfig:  () => {},
    removeRerankConfig:  () => {},
    firstRerankId:       () => undefined,
    defaultRerankModelFor: () => undefined,
    probeEmbed:          async () => ({ ok: true }),
    probeRerank:         async () => ({ ok: true }),
  } as unknown as MemoryDeps['ebd'];
}

// ── Mock SessionStore ─────────────────────────────────────────────────────────
//
// plan() calls session.getSession(id) only to read meta.alreadySurfaced.
// Returning an empty-meta Session is correct — the bench starts fresh each case.

function makeBenchSessionStore(): MemoryDeps['session'] {
  return {
    getSession: (id: string) => ({
      id,
      title:            'bench',
      characterCardId:  'ema',
      workspaceRoots:   [],
      createdAt:        Date.now(),
      updatedAt:        Date.now(),
      archivedAt:       null,
      pinned:           false,
      pinnedAt:         null,
      groupLabel:       null,
      parentSessionId:  null,
      runningTurnCount: 0,
      meta:             {},
      lastMode:         null,
      lastSubMode:      null,
    }),
  } as unknown as MemoryDeps['session'];
}

// ── BenchDeps bundle ───────────────────────────────────────────────────────────

export interface BenchDeps {
  deps:    MemoryDeps;
  items:   MemoryItemsRepo;
  /** Close the in-memory SQLite DB when the case is done. */
  close:   () => void;
}

/**
 * Create a fully-wired MemoryDeps backed by a throwaway in-memory SQLite DB.
 * Call `close()` when done to free the connection.
 */
export function createBenchDeps(embedCache: EmbedCache): BenchDeps {
  // ── In-memory DB + schema ─────────────────────────────────────────────────
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();   // runs data/001_initial.sql + data/002_session_last_mode.sql

  const sq = db.sqlite;

  // ── Real repos ────────────────────────────────────────────────────────────
  const sessions      = new SessionsRepo(sq);
  const nodes         = new MemoryNodesRepo(sq);
  const edges         = new MemoryEdgesRepo(sq);
  const lazyUpdates   = new MemoryLazyUpdatesRepo(sq);
  const items         = new MemoryItemsRepo(sq);
  const sessionNotes  = new SessionNotesRepo(sq);
  const backgroundTasks = new BackgroundTasksRepo(sq);

  // ModelBindingsRepo lives in the profile DB; we never call it during plan()
  const modelBindings = {} as unknown as ModelBindingsRepo;

  const deps: MemoryDeps = {
    db,
    session:         makeBenchSessionStore(),
    llm:             {} as unknown as MemoryDeps['llm'],
    ebd:             makeBenchEbdRouter(embedCache),
    narrative:       {} as unknown as MemoryDeps['narrative'],
    modelBindings,
    nodes,
    edges,
    lazyUpdates,
    items,
    sessionNotes,
    backgroundTasks,
    sessions,
    getEmbedDim:     (model) => model === BENCH_MODEL ? EMBED_DIM : 0,
  };

  return { deps, items, close: () => db.close() };
}

// ── Item insert helper ─────────────────────────────────────────────────────────

export interface BenchItemInput {
  title: string;
  body:  string;
  vec:   number[];   // raw (non-normalized) BGE-M3 vector
}

/**
 * Insert a batch of extracted items with pre-computed embeddings into the
 * bench MemoryItemsRepo.  Returns the list of inserted item IDs (UUIDs).
 */
export function insertBenchItems(
  repo:  MemoryItemsRepo,
  batch: BenchItemInput[],
): string[] {
  const now = Date.now();
  const ids: string[] = [];

  for (const it of batch) {
    const id = crypto.randomUUID();
    ids.push(id);
    repo.insert({
      id,
      kind:                 'user',
      title:                it.title,
      body:                 it.body,
      modes:                ['chat', 'agent'],
      embedding:            packEmbedding(it.vec),   // normalises + packs to Buffer
      embeddingProviderId:  BENCH_PROVIDER_ID,
      embeddingModel:       BENCH_MODEL,
      embeddingDim:         EMBED_DIM,
      createdAt:            now,
    });
  }

  return ids;
}
