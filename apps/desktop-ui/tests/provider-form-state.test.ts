// 测试 Provider 表单的空密钥、原样提交、字段规范化和新建资格。
import { describe, expect, it } from 'vitest';
import {
  isProviderConfigDirty,
  resolveCredentialOperation,
  resolveProviderSubmitState,
  type ProviderFormDraft,
  type ProviderFormSnapshot,
} from '../src/settings/provider-form-state.js';

const snapshot: ProviderFormSnapshot = {
  baseUrl: 'https://api.example.com/v1',
  protocol: 'openai-llm',
};

function draft(overrides: Partial<ProviderFormDraft> = {}): ProviderFormDraft {
  return {
    apiKey: '',
    credentialDirty: false,
    baseUrl: snapshot.baseUrl,
    protocol: snapshot.protocol,
    ...overrides,
  };
}

describe('Provider 表单状态', () => {
  it('已有配置原样不动或只有首尾空格时不提交', () => {
    expect(isProviderConfigDirty(draft(), snapshot)).toBe(false);
    expect(isProviderConfigDirty(draft({ baseUrl: `  ${snapshot.baseUrl}  ` }), snapshot)).toBe(false);
    expect(resolveProviderSubmitState({
      draft: draft(),
      snapshot,
      existing: true,
      requiresCredentials: true,
    })).toEqual({ dirty: false, valid: true, submittable: false });
  });

  it('未编辑密钥时保持原值，主动删空时明确清除', () => {
    expect(resolveCredentialOperation('', false)).toEqual({ type: 'keep' });
    expect(resolveCredentialOperation('   ', true)).toEqual({ type: 'clear' });
    expect(resolveCredentialOperation('  secret-v2  ', true)).toEqual({
      type: 'replace',
      value: 'secret-v2',
    });
  });

  it('已有配置允许清空密钥并将其识别为有效修改', () => {
    expect(resolveProviderSubmitState({
      draft: draft({ credentialDirty: true }),
      snapshot,
      existing: true,
      requiresCredentials: true,
    })).toEqual({ dirty: true, valid: true, submittable: true });
  });

  it('新建远程 Provider 要求密钥，本地免密 Provider 可以直接创建', () => {
    const emptyDraft = draft();
    expect(resolveProviderSubmitState({
      draft: emptyDraft,
      snapshot,
      existing: false,
      requiresCredentials: true,
    })).toEqual({ dirty: false, valid: false, submittable: false });
    expect(resolveProviderSubmitState({
      draft: emptyDraft,
      snapshot,
      existing: false,
      requiresCredentials: false,
    })).toEqual({ dirty: false, valid: true, submittable: true });
  });

  it('Base URL 清空和协议切换都会产生修改', () => {
    expect(isProviderConfigDirty(draft({ baseUrl: '' }), snapshot)).toBe(true);
    expect(isProviderConfigDirty(draft({ protocol: 'anthropic-llm' }), snapshot)).toBe(true);
  });
});
