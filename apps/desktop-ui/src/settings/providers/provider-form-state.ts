// 管理 Provider 编辑表单的快照比较、空密钥语义和提交资格。
import type { ProviderCredentialOperation } from '@ema-agent/provider';

export interface ProviderFormSnapshot {
  baseUrl: string;
  protocol: string;
}

export interface ProviderFormDraft extends ProviderFormSnapshot {
  apiKey: string;
  credentialDirty: boolean;
}

export interface ProviderSubmitState {
  dirty: boolean;
  valid: boolean;
  submittable: boolean;
}

export function normalizeProviderText(value: string): string {
  return value.trim();
}

export function isProviderConfigDirty(
  draft: ProviderFormDraft,
  snapshot: ProviderFormSnapshot,
): boolean {
  return draft.credentialDirty
    || normalizeProviderText(draft.baseUrl) !== normalizeProviderText(snapshot.baseUrl)
    || draft.protocol !== snapshot.protocol;
}

export function resolveCredentialOperation(
  apiKey: string,
  credentialDirty: boolean,
): ProviderCredentialOperation {
  if (!credentialDirty) return { type: 'keep' };
  const value = normalizeProviderText(apiKey);
  return value ? { type: 'replace', value } : { type: 'clear' };
}

export function resolveProviderSubmitState(args: {
  draft: ProviderFormDraft;
  snapshot: ProviderFormSnapshot;
  existing: boolean;
  requiresCredentials: boolean;
}): ProviderSubmitState {
  const dirty = isProviderConfigDirty(args.draft, args.snapshot);
  const hasRequiredCredential = args.existing
    || !args.requiresCredentials
    || normalizeProviderText(args.draft.apiKey).length > 0;
  return {
    dirty,
    valid: hasRequiredCredential,
    submittable: hasRequiredCredential && (!args.existing || dirty),
  };
}
