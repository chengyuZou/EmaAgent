import { sidecarClient } from './sidecar-client.js';
import type { PermissionResponse } from '@ema-agent/permission';

export const permissionApi = {
  /** GET /api/permission/pending — number of in-flight prompt registrations */
  pending(): Promise<{ count: number }> {
    return sidecarClient.request<{ count: number }>('/api/permission/pending');
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
