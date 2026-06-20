/**
 * Artifacts API — session-scoped artifact CRUD.
 * GET  /api/sessions/:sessionId/artifacts   list
 * GET  /api/artifacts/:id                   single
 * POST /api/artifacts/:id/apply             write to workspace
 * POST /api/artifacts/:id/reject            mark rejected
 * DELETE /api/artifacts/:id                 delete
 */
import { sidecarClient } from './sidecar-client.js';
import type { Artifact, ArtifactId, SessionId } from '@ema-agent/contracts';

export interface ArtifactListResult {
  artifacts: Artifact[];
}

export interface ArtifactApplyInput {
  targetPath: string;
}

export const artifactsApi = {
  /** GET /api/sessions/:sessionId/artifacts */
  async list(sessionId: SessionId, opts?: { type?: string }): Promise<ArtifactListResult> {
    const params = new URLSearchParams();
    if (opts?.type) params.set('type', opts.type);
    const qs = params.toString();
    return sidecarClient.request<ArtifactListResult>(
      `/api/sessions/${sessionId}/artifacts${qs ? `?${qs}` : ''}`,
    );
  },

  /** GET /api/artifacts/:id */
  async get(id: ArtifactId): Promise<{ artifact: Artifact }> {
    return sidecarClient.request<{ artifact: Artifact }>(`/api/artifacts/${id}`);
  },

  /** POST /api/artifacts/:id/apply */
  async apply(id: ArtifactId, targetPath: string): Promise<{ artifact: Artifact }> {
    return sidecarClient.request<{ artifact: Artifact }>(`/api/artifacts/${id}/apply`, {
      method: 'POST',
      json: { targetPath },
    });
  },

  /** POST /api/artifacts/:id/reject */
  async reject(id: ArtifactId): Promise<{ artifact: Artifact }> {
    return sidecarClient.request<{ artifact: Artifact }>(`/api/artifacts/${id}/reject`, {
      method: 'POST',
    });
  },

  /** DELETE /api/artifacts/:id */
  async delete(id: ArtifactId): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/artifacts/${id}`, {
      method: 'DELETE',
    });
  },
};
