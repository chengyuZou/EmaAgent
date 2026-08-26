// 管理 Provider 编辑表单的基线比较、密钥输入语义和提交资格。
export interface ProviderFormBaseline {
  baseUrl: string;
  protocol: string;
}

export interface ProviderFormDraft extends ProviderFormBaseline {
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
  baseline: ProviderFormBaseline,
): boolean {
  return draft.credentialDirty
    || normalizeProviderText(draft.baseUrl) !== normalizeProviderText(baseline.baseUrl)
    || draft.protocol !== baseline.protocol;
}

/** 密钥语义：非空输入在保存时写入并设为 active；空 = 不动现有 key（清空走 key 管理，不在表单里猜）。 */
export function resolveProviderSubmitState(args: {
  draft: ProviderFormDraft;
  baseline: ProviderFormBaseline;
  requiresCredentials: boolean;
  hasActiveKey: boolean;
}): ProviderSubmitState {
  const dirty = isProviderConfigDirty(args.draft, args.baseline);
  const hasRequiredCredential = !args.requiresCredentials
    || args.hasActiveKey
    || normalizeProviderText(args.draft.apiKey).length > 0;
  return {
    dirty,
    valid: hasRequiredCredential,
    submittable: hasRequiredCredential && dirty,
  };
}
