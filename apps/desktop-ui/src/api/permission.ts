import { sidecarClient } from './sidecar-client.js';
import type { PendingPermissionPrompt, PermissionResponse } from '@ema-agent/permission';

export const permissionApi = {
  /** GET /api/permission/pending — recoverable in-flight prompt snapshots */
  pending(): Promise<{ count: number; prompts: PendingPermissionPrompt[] }> {
    return sidecarClient.request('/api/permission/pending');
  },

  respond(promptId: string, response: PermissionResponse): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/${promptId}/respond`, {
      method: 'POST',
      json: response,
    });
  },

  cancel(promptId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/${promptId}/cancel`, {
      method: 'POST',
    });
  },
};
