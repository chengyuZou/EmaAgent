import { create } from 'zustand';
import { artifactsApi } from '../api/artifacts.js';
import type { Artifact, ArtifactId, SessionId } from '@ema-agent/contracts';

// ── State ──────────────────────────────────────────────────────────────────────

export interface ArtifactStoreState {
  /** per-session artifact list, populated by SSE and HTTP load */
  bySession: Map<string, Artifact[]>;

  // ── SSE-driven ──────────────────────────────────────────────────────────────
  /** artifact_upserted: insert or replace artifact in its session bucket */
  upsertFromEvent(artifact: Artifact): void;
  /** artifact_applied: optimistic appliedAt stamp — used when backend emits the event */
  markAppliedFromEvent(id: ArtifactId): void;

  // ── HTTP-driven ─────────────────────────────────────────────────────────────
  /** Load metadata list for a session (skips if already loaded) */
  loadForSession(sessionId: SessionId): Promise<void>;
  /** POST /api/artifacts/:id/apply — returns updated artifact with appliedAt */
  applyArtifact(id: ArtifactId, targetPath: string): Promise<Artifact>;
  /** POST /api/artifacts/:id/reject — returns updated artifact with rejectedAt */
  rejectArtifact(id: ArtifactId): Promise<Artifact>;
  /** DELETE /api/artifacts/:id */
  deleteArtifact(id: ArtifactId): Promise<void>;

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  evictSession(sessionId: SessionId): void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function upsertIntoList(list: Artifact[], incoming: Artifact): Artifact[] {
  const idx = list.findIndex((a) => a.id === incoming.id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = incoming;
    return next;
  }
  return [...list, incoming];
}

function updateInAllSessions(
  bySession: Map<string, Artifact[]>,
  id: ArtifactId,
  patch: (a: Artifact) => Artifact,
): Map<string, Artifact[]> {
  const next = new Map(bySession);
  for (const [sid, list] of next) {
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) {
      const updated = [...list];
      updated[idx] = patch(list[idx]!);
      next.set(sid, updated);
      break;
    }
  }
  return next;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useArtifactStore = create<ArtifactStoreState>((set, get) => ({
  bySession: new Map(),

  upsertFromEvent(artifact) {
    const sid = artifact.sessionId as string;
    set((s) => {
      const list = s.bySession.get(sid) ?? [];
      const next = new Map(s.bySession);
      next.set(sid, upsertIntoList(list, artifact));
      return { bySession: next };
    });
  },

  markAppliedFromEvent(id) {
    set((s) => ({
      bySession: updateInAllSessions(s.bySession, id, (a) => ({
        ...a,
        appliedAt: Date.now(),
        updatedAt: Date.now(),
      } as Artifact)),
    }));
  },

  async loadForSession(sessionId) {
    const sid = sessionId as string;
    if (get().bySession.has(sid)) return;

    const { artifacts } = await artifactsApi.list(sessionId);
    set((s) => {
      const next = new Map(s.bySession);
      next.set(sid, artifacts);
      return { bySession: next };
    });
  },

  async applyArtifact(id, targetPath) {
    const { artifact } = await artifactsApi.apply(id, targetPath);
    set((s) => ({
      bySession: updateInAllSessions(s.bySession, id, () => artifact),
    }));
    return artifact;
  },

  async rejectArtifact(id) {
    const { artifact } = await artifactsApi.reject(id);
    set((s) => ({
      bySession: updateInAllSessions(s.bySession, id, () => artifact),
    }));
    return artifact;
  },

  async deleteArtifact(id) {
    await artifactsApi.delete(id);
    set((s) => {
      const next = new Map(s.bySession);
      for (const [sid, list] of next) {
        const filtered = list.filter((a) => a.id !== id);
        if (filtered.length !== list.length) {
          next.set(sid, filtered);
          break;
        }
      }
      return { bySession: next };
    });
  },

  evictSession(sessionId) {
    const sid = sessionId as string;
    set((s) => {
      const next = new Map(s.bySession);
      next.delete(sid);
      return { bySession: next };
    });
  },
}));
