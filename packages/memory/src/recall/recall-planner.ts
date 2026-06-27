import type { SessionId } from '@ema-agent/contracts';
import { estimateTextTokens } from '@ema-agent/token';
import { bestEffort, bestEffortAsync } from '../best-effort.js';
import type { MemoryDeps } from '../deps.js';
import type {
  PlanContext, RecallBundle, MemorySettings, AlreadySurfaced,
  GraphRecallResult, EpisodicRecallResult,
} from '../types.js';
import type { EmbedService } from '../embed/service.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import { recallGraph }       from './layer0-graph.js';
import { recallSessionNote } from './layer1-notes.js';
import { recallEpisodic }    from './layer2-episodic.js';
import {
  emitRecallLayer, estimateGraphRecallTokens,
  countEpisodicItems, estimateEpisodicRecallTokens, errorMessage,
} from './context-builder.js';
import { loadSurfaced, dedupTail } from './surfaced.js';
import type { ResolvedSessionOverrides } from '../maintenance/overrides.js';

// ── rerank helpers ───────────────────────────────────────────────────────────

export async function rerankLayer0(
  embed:  EmbedService,
  query:  string,
  result: GraphRecallResult,
  signal?: AbortSignal,
): Promise<GraphRecallResult> {
  const documents = result.nodes.map(n => `${n.label}: ${n.description}`);
  const scores    = await embed.rerank(query, documents, documents.length, signal);
  if (!scores) return result;
  const reranked = [...result.nodes]
    .map((node, i) => ({ node, score: scores.get(i) ?? -Infinity }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.node);
  return { nodes: reranked, edges: result.edges };
}

export async function rerankEpisodic(
  embed:  EmbedService,
  query:  string,
  result: EpisodicRecallResult,
  signal?: AbortSignal,
): Promise<EpisodicRecallResult> {
  const allItems  = [...result.currentMode, ...result.otherModes];
  const documents = allItems.map(i => `${i.title}: ${i.body}`);
  const scores    = await embed.rerank(query, documents, documents.length, signal);
  if (!scores) return result;

  const rerank = <T>(items: T[], offset: number): T[] =>
    [...items]
      .map((item, i) => ({ item, score: scores.get(offset + i) ?? -Infinity }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.item);

  return {
    currentMode: rerank(result.currentMode, 0),
    otherModes:  rerank(result.otherModes,  result.currentMode.length),
  };
}

// ── surfaced tracking ────────────────────────────────────────────────────────

export function recordSurfaced(
  deps:      MemoryDeps,
  settings:  MemorySettings,
  sessionId: SessionId,
  prior:     AlreadySurfaced,
  bundle:    { layer0?: GraphRecallResult | null; layer2?: EpisodicRecallResult | null },
): void {
  const nowMs     = Date.now();
  const newNodes: string[] = [];
  const newItems: string[] = [];

  if (bundle.layer0) {
    for (const n of bundle.layer0.nodes) newNodes.push(n.id);
  }
  if (bundle.layer2) {
    for (const i of bundle.layer2.currentMode) newItems.push(i.id);
    for (const i of bundle.layer2.otherModes)  newItems.push(i.id);
  }

  const boost = {
    maxBoost:         settings.maintenance.reReferenceBoostMax,
    halfLifeDays:     settings.maintenance.reReferenceHalfLifeDays,
    saturationStart:  settings.maintenance.boostSaturationStart,
    saturationSlope:  settings.maintenance.boostSaturationSlope,
  };

  bestEffort('touchReferenced nodes', () => deps.nodes.touchReferenced(newNodes, nowMs, boost), undefined);
  bestEffort('touchReferenced items', () => deps.items.touchReferenced(newItems, nowMs, boost), undefined);

  const merged: AlreadySurfaced = {
    nodes:     dedupTail([...prior.nodes, ...newNodes], 200),
    items:     dedupTail([...prior.items, ...newItems], 200),
    updatedAt: nowMs,
  };
  bestEffort('persistSurfaced', () =>
    deps.memorySessionState.setSurfaced(sessionId, merged as unknown as Record<string, unknown>),
  undefined);
}

// ── main recall function ─────────────────────────────────────────────────────

export async function planRecall(
  deps:                MemoryDeps,
  embed:               EmbedService,
  settings:            MemorySettings,
  nodesIndex:          VectorIndex | null,
  itemsIndex:          VectorIndex | null,
  getSessionOverrides: (sessionId: SessionId) => ResolvedSessionOverrides,
  ctx:                 PlanContext,
): Promise<RecallBundle> {
  if (!settings.enabled) {
    for (const layer of ['layer0', 'layer1', 'layer2'] as const) {
      emitRecallLayer(ctx, layer, { status: 'skipped', itemCount: 0, tokenEstimate: 0, durationMs: 0, skippedReason: 'memory_disabled' });
    }
    return { layer0: null, layer1: null, layer2: null };
  }

  const overrides = getSessionOverrides(ctx.sessionId);
  const prior     = loadSurfaced(deps.memorySessionState.getSurfaced(ctx.sessionId));

  const embedded  = embed.isAvailable()
    ? await bestEffortAsync('embedQuery', () => embed.embedQuery(ctx.userInput), null)
    : null;
  const queryVec   = embedded?.queryVec   ?? null;
  const queryEmbed = embedded?.embedded   ?? null;

  let layer0: RecallBundle['layer0'] = null;
  let layer1: RecallBundle['layer1'] = null;
  let layer2: RecallBundle['layer2'] = null;

  const layer0Task = async (): Promise<void> => {
    const t0 = Date.now();
    if (!overrides.layer0) {
      emitRecallLayer(ctx, 'layer0', { status: 'skipped', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, skippedReason: 'layer_disabled' });
      return;
    }
    if (!queryVec || !queryEmbed) {
      emitRecallLayer(ctx, 'layer0', { status: 'skipped', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, skippedReason: 'embedding_unavailable' });
      return;
    }
    try {
      layer0 = recallGraph(deps, { queryVec, queryEmbed, index: nodesIndex, alreadySurfaced: new Set(prior.nodes), settings });
      if (settings.recall.useReranker && layer0.nodes.length > 1) {
        layer0 = await rerankLayer0(embed, ctx.userInput, layer0, ctx.signal);
      }
      emitRecallLayer(ctx, 'layer0', { status: 'succeeded', itemCount: layer0.nodes.length, tokenEstimate: estimateGraphRecallTokens(layer0), durationMs: Date.now() - t0 });
    } catch (err) {
      layer0 = null;
      emitRecallLayer(ctx, 'layer0', { status: 'failed', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, error: errorMessage(err) });
    }
  };

  const layer1Task = async (): Promise<void> => {
    const t0 = Date.now();
    if (!overrides.layer1) {
      emitRecallLayer(ctx, 'layer1', { status: 'skipped', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, skippedReason: 'layer_disabled' });
      return;
    }
    try {
      layer1 = recallSessionNote(deps, ctx.sessionId);
      emitRecallLayer(ctx, 'layer1', { status: 'succeeded', itemCount: layer1 ? 1 : 0, tokenEstimate: layer1 ? estimateTextTokens(layer1) : 0, durationMs: Date.now() - t0 });
    } catch (err) {
      layer1 = null;
      emitRecallLayer(ctx, 'layer1', { status: 'failed', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, error: errorMessage(err) });
    }
  };

  const layer2Task = async (): Promise<void> => {
    const t0 = Date.now();
    if (!overrides.layer2) {
      emitRecallLayer(ctx, 'layer2', { status: 'skipped', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, skippedReason: 'layer_disabled' });
      return;
    }
    try {
      const mode = ctx.mode === 'narrative' ? 'narrative' : ctx.mode;
      layer2 = await recallEpisodic(deps, { query: ctx.userInput, queryVec, queryEmbed, index: itemsIndex, mode, alreadySurfaced: new Set(prior.items), settings });
      if (settings.recall.useReranker && (layer2.currentMode.length + layer2.otherModes.length) > 1) {
        layer2 = await rerankEpisodic(embed, ctx.userInput, layer2, ctx.signal);
      }
      emitRecallLayer(ctx, 'layer2', { status: 'succeeded', itemCount: countEpisodicItems(layer2), tokenEstimate: estimateEpisodicRecallTokens(layer2), durationMs: Date.now() - t0 });
    } catch (err) {
      layer2 = null;
      emitRecallLayer(ctx, 'layer2', { status: 'failed', itemCount: 0, tokenEstimate: 0, durationMs: Date.now() - t0, error: errorMessage(err) });
    }
  };

  await Promise.allSettled([layer0Task(), layer1Task(), layer2Task()]);

  recordSurfaced(deps, settings, ctx.sessionId, prior, { layer0, layer2 });

  return { layer0, layer1, layer2 };
}
