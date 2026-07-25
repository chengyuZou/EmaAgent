import { sidecarClient } from './sidecar-client.js';
import type {
  PendingPermissionPrompt,
  PermissionResponse,
  PermissionRule,
  PersistedPermissionRule,
} from '@ema-agent/permission';
import type { TurnId } from '@ema-agent/ids';

export const permissionApi = {
  /** GET /api/permission/pending — recoverable in-flight prompt snapshots */
  pending(): Promise<{ count: number; prompts: PendingPermissionPrompt[] }> {
    return sidecarClient.request('/api/permission/pending');
  },

  respond(turnId: TurnId, promptId: string, response: PermissionResponse): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/${turnId}/${promptId}/respond`, {
      method: 'POST',
      json: response,
    });
  },

  cancel(turnId: TurnId, promptId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/${turnId}/${promptId}/cancel`, {
      method: 'POST',
    });
  },

  listRules(): Promise<{ rules: PersistedPermissionRule[] }> {
    return sidecarClient.request('/api/permission/rules');
  },

  addRule(rule: PermissionRule): Promise<{ rule: PersistedPermissionRule }> {
    return sidecarClient.request('/api/permission/rules', {
      method: 'POST',
      json: rule,
    });
  },

  setRuleEnabled(ruleId: string, enabled: boolean): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/rules/${ruleId}`, {
      method: 'PATCH',
      json: { enabled },
    });
  },

  removeRule(ruleId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/permission/rules/${ruleId}`, {
      method: 'DELETE',
    });
  },
};
