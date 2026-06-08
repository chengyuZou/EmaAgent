import { sidecarClient } from './sidecar-client.js';

// Mirror of routes/permission.ts respondSchema
export type PermissionAction =
  | { action: 'allow' }
  | { action: 'allow_session' }
  | { action: 'always_allow'; scope: 'session' | 'project' | 'global' }
  | { action: 'always_deny';  scope: 'session' | 'project' | 'global' }
  | { action: 'deny'; reason?: string };

export const permissionApi = {
  respond(promptId: string, response: PermissionAction): Promise<{ ok: boolean }> {
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
