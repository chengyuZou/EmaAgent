// 管理按 Session 隔离的 Artifact 快照、SSE 更新、缓存代次与应用操作。
import { create } from 'zustand';
import { artifactsApi } from '../api/artifacts.js';
import type { Artifact, ArtifactId, SessionId } from '@ema-agent/contracts';

export type ArtifactLoadState =
  | { status: 'idle'; generation: number; error: null }
  | { status: 'loading'; generation: number; error: null }
  | { status: 'ready'; generation: number; error: null; loadedAt: number }
  | { status: 'stale'; generation: number; error: string | null; loadedAt?: number }
  | { status: 'error'; generation: number; error: string };

export interface ArtifactStoreState {
  /** 每个 Session 的权威 Artifact 列表或带 generation 的本地即时快照。 */
  bySession: Map<string, Artifact[]>;
  loadStateBySession: Map<string, ArtifactLoadState>;

  upsertFromEvent(artifact: Artifact): void;
  markAppliedFromEvent(id: ArtifactId): void;

  loadForSession(sessionId: SessionId): Promise<void>;
  /** 提升代次并保留当前数据显示为 stale，下一位消费者会重新拉取。 */
  invalidateSession(sessionId: SessionId): void;
  applyArtifact(id: ArtifactId, targetPath: string): Promise<Artifact>;
  rejectArtifact(id: ArtifactId): Promise<Artifact>;
  deleteArtifact(id: ArtifactId): Promise<void>;
  evictSession(sessionId: SessionId): void;
}

interface LocatedArtifact {
  sessionId: string;
  artifact: Artifact;
}

const inFlightLoads = new Map<string, {
  generation: number;
  requestId: symbol;
  promise: Promise<void>;
}>();

function upsertIntoList(list: Artifact[], incoming: Artifact): Artifact[] {
  const index = list.findIndex((artifact) => artifact.id === incoming.id);
  if (index < 0) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

function locateArtifact(
  bySession: Map<string, Artifact[]>,
  id: ArtifactId,
): LocatedArtifact | null {
  for (const [sessionId, artifacts] of bySession) {
    const artifact = artifacts.find((candidate) => candidate.id === id);
    if (artifact) return { sessionId, artifact };
  }
  return null;
}

function currentGeneration(state: ArtifactStoreState, sessionId: string): number {
  return state.loadStateBySession.get(sessionId)?.generation ?? 0;
}

function invalidatedLoadState(
  state: ArtifactStoreState,
  sessionId: string,
): ArtifactLoadState {
  const previous = state.loadStateBySession.get(sessionId);
  const generation = (previous?.generation ?? 0) + 1;
  return {
    status: 'stale',
    generation,
    error: null,
    ...(previous && 'loadedAt' in previous ? { loadedAt: previous.loadedAt } : {}),
  };
}

export const useArtifactStore = create<ArtifactStoreState>((set, get) => ({
  bySession: new Map(),
  loadStateBySession: new Map(),

  upsertFromEvent(artifact) {
    const sessionId = artifact.sessionId as string;
    set((state) => {
      const bySession = new Map(state.bySession);
      bySession.set(sessionId, upsertIntoList(bySession.get(sessionId) ?? [], artifact));
      const loadStates = new Map(state.loadStateBySession);
      loadStates.set(sessionId, invalidatedLoadState(state, sessionId));
      return { bySession, loadStateBySession: loadStates };
    });
  },

  markAppliedFromEvent(id) {
    set((state) => {
      const located = locateArtifact(state.bySession, id);
      if (!located) return {};
      const now = Date.now();
      const bySession = new Map(state.bySession);
      bySession.set(
        located.sessionId,
        upsertIntoList(bySession.get(located.sessionId) ?? [], {
          ...located.artifact,
          appliedAt: now,
          updatedAt: now,
        } as Artifact),
      );
      const loadStates = new Map(state.loadStateBySession);
      loadStates.set(located.sessionId, invalidatedLoadState(state, located.sessionId));
      return { bySession, loadStateBySession: loadStates };
    });
  },

  loadForSession(sessionId) {
    const key = sessionId as string;
    const state = get();
    const loadState = state.loadStateBySession.get(key);
    if (loadState?.status === 'ready') return Promise.resolve();

    const generation = loadState?.generation ?? 0;
    const existing = inFlightLoads.get(key);
    if (existing?.generation === generation) return existing.promise;
    const requestId = Symbol(key);

    set((current) => {
      const loadStates = new Map(current.loadStateBySession);
      loadStates.set(key, { status: 'loading', generation, error: null });
      return { loadStateBySession: loadStates };
    });

    const promise = artifactsApi.list(sessionId)
      .then(({ artifacts }) => {
        if (inFlightLoads.get(key)?.requestId !== requestId) return;
        set((current) => {
          if (currentGeneration(current, key) !== generation) return {};
          const bySession = new Map(current.bySession);
          bySession.set(key, artifacts);
          const loadStates = new Map(current.loadStateBySession);
          loadStates.set(key, {
            status: 'ready',
            generation,
            error: null,
            loadedAt: Date.now(),
          });
          return { bySession, loadStateBySession: loadStates };
        });
      })
      .catch((error: unknown) => {
        if (inFlightLoads.get(key)?.requestId !== requestId) return;
        set((current) => {
          if (currentGeneration(current, key) !== generation) return {};
          const message = error instanceof Error ? error.message : '加载 Artifact 失败';
          const previous = current.loadStateBySession.get(key);
          const loadStates = new Map(current.loadStateBySession);
          loadStates.set(key, current.bySession.has(key)
            ? {
                status: 'stale',
                generation,
                error: message,
                ...(previous && 'loadedAt' in previous ? { loadedAt: previous.loadedAt } : {}),
              }
            : { status: 'error', generation, error: message });
          return { loadStateBySession: loadStates };
        });
        throw error;
      })
      .finally(() => {
        if (inFlightLoads.get(key)?.requestId === requestId) inFlightLoads.delete(key);
      });

    inFlightLoads.set(key, { generation, requestId, promise });
    return promise;
  },

  invalidateSession(sessionId) {
    const key = sessionId as string;
    set((state) => {
      const loadStates = new Map(state.loadStateBySession);
      loadStates.set(key, invalidatedLoadState(state, key));
      return { loadStateBySession: loadStates };
    });
  },

  async applyArtifact(id, targetPath) {
    const { artifact } = await artifactsApi.apply(id, targetPath);
    get().upsertFromEvent(artifact);
    return artifact;
  },

  async rejectArtifact(id) {
    const { artifact } = await artifactsApi.reject(id);
    get().upsertFromEvent(artifact);
    return artifact;
  },

  async deleteArtifact(id) {
    const located = locateArtifact(get().bySession, id);
    await artifactsApi.delete(id);
    if (!located) return;
    set((state) => {
      const bySession = new Map(state.bySession);
      bySession.set(
        located.sessionId,
        (bySession.get(located.sessionId) ?? []).filter((artifact) => artifact.id !== id),
      );
      const loadStates = new Map(state.loadStateBySession);
      loadStates.set(located.sessionId, invalidatedLoadState(state, located.sessionId));
      return { bySession, loadStateBySession: loadStates };
    });
  },

  evictSession(sessionId) {
    const key = sessionId as string;
    inFlightLoads.delete(key);
    set((state) => {
      const bySession = new Map(state.bySession);
      const loadStates = new Map(state.loadStateBySession);
      bySession.delete(key);
      loadStates.delete(key);
      return { bySession, loadStateBySession: loadStates };
    });
  },
}));
