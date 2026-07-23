import { sidecarClient } from './sidecar-client.js';
import type { SessionId } from '@ema-agent/ids';
import type { SessionDashboardWire, SessionNoteWire } from '@ema-agent/session';
import type { ImportWarningWire } from '@ema-agent/backup';

// ── DataDir wire types ────────────────────────────────────────────────────────

export interface DataDirItem {
  name:        string;
  path:        string;
  isActive:    boolean;
  addedAt:     number;
  dataDbBytes: number;
}

export interface DataDirListResult {
  active: string;
  dirs:   DataDirItem[];
}

export interface StorageStatsWire {
  path:            string;
  sessionCount:    number;
  turnCount:       number;
  messageCount:    number;
  artifactCount:   number;
  agentRunCount:   number;
  audioCount:      number;
  audioDurationMs: number;
  dataDbBytes:     number;
  audioBytes:      number;
  sessionsBytes:   number;
  totalBytes:      number;
}

export type { SessionDashboardWire, SessionNoteWire };

// ── API object ────────────────────────────────────────────────────────────────

export const storageApi = {
  // ── DataDir management ───────────────────────────────────────────────────

  /** GET /api/storage — list all registered DataDirs. */
  async listDirs(): Promise<DataDirListResult> {
    return sidecarClient.request<DataDirListResult>('/api/storage');
  },

  /** POST /api/storage — register a new DataDir. */
  async addDir(opts: { name: string; path: string }): Promise<DataDirItem> {
    return sidecarClient.request<DataDirItem>('/api/storage', {
      method: 'POST',
      json: opts,
    });
  },

  /** DELETE /api/storage/:name — unregister (no disk deletion). */
  async removeDir(name: string): Promise<void> {
    await sidecarClient.request(`/api/storage/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  /** POST /api/storage/:name/activate — switch active DataDir (restart required). */
  async activateDir(name: string): Promise<{ ok: boolean; restartRequired: boolean }> {
    return sidecarClient.request(`/api/storage/${encodeURIComponent(name)}/activate`, {
      method: 'POST',
    });
  },

  /** GET /api/storage/stats — aggregate stats for the active DataDir. */
  async getStats(): Promise<StorageStatsWire> {
    return sidecarClient.request<StorageStatsWire>('/api/storage/stats');
  },

  /** POST /api/storage/migrate — hot-copy active dir to a new path, then register + activate. */
  async migrate(opts: {
    name:       string;
    targetPath: string;
  }): Promise<{ ok: boolean; restartRequired: boolean; targetPath: string }> {
    return sidecarClient.request('/api/storage/migrate', {
      method: 'POST',
      json: opts,
    });
  },

  // ── Session detail — lives at /api/storage/sessions/* ───────────────────

  /** GET /api/storage/sessions/:id/dashboard */
  async getDashboard(id: SessionId): Promise<SessionDashboardWire> {
    return sidecarClient.request<SessionDashboardWire>(`/api/storage/sessions/${id}/dashboard`);
  },

  /** GET /api/storage/sessions/:id/notes */
  async getNotes(id: SessionId): Promise<SessionNoteWire | null> {
    return sidecarClient.request<SessionNoteWire | null>(`/api/storage/sessions/${id}/notes`);
  },

  /** POST /api/storage/sessions/:id/export — download session as ZIP Blob. */
  async exportSession(id: SessionId): Promise<Blob> {
    const res = await sidecarClient.requestRaw(`/api/storage/sessions/${id}/export`, { method: 'POST' });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },

  /** POST /api/storage/sessions/import — upload a ZIP and restore the session. */
  async importSession(file: File): Promise<{ id: string; title: string; warnings?: ImportWarningWire[] }> {
    const form = new FormData();
    form.append('file', file);
    const res = await sidecarClient.requestRaw('/api/storage/sessions/import', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
      throw new Error(body.message ?? `Import failed: ${res.status}`);
    }
    return res.json() as Promise<{ id: string; title: string; warnings?: ImportWarningWire[] }>;
  },
};
