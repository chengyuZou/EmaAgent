/** ProviderForm — provider 单能力档位编辑器（协议/Base URL/首把 key/探活 + 模型池）。 */
import { useState, useEffect, type FormEvent, type JSX } from 'react';
import {
  Button,
  Callout,
  IconButton,
  Input,
  Select,
  resolveProviderIconClass,
} from '@ema-agent/ui';
import { useProviderStore } from '../../stores/provider.js';
import {
  providersApi,
  type ModelCapability,
  type ProviderRecord,
} from '../../api/providers.js';
import { PROVIDER_LIMITS, type Protocol } from '@ema-agent/providers/types';
import { showToast } from '../../lib/toast.js';
import { ProviderModelManager } from './ProviderModelManager.js';

export interface ProviderFormProps {
  provider:   ProviderRecord;
  capability: ModelCapability;
  onClose():  void;
  onDirtyChange?(dirty: boolean): void;
}

// ── 基线比较与提交资格 ────────────────────────────────────────────────────────

interface ProviderFormBaseline {
  baseUrl: string;
  protocol: string;
}

interface ProviderFormDraft extends ProviderFormBaseline {
  apiKey: string;
  credentialDirty: boolean;
}

interface ProviderSubmitState {
  dirty: boolean;
  valid: boolean;
  submittable: boolean;
}

function isProviderConfigDirty(
  draft: ProviderFormDraft,
  baseline: ProviderFormBaseline,
): boolean {
  return draft.credentialDirty
    || draft.baseUrl.trim() !== baseline.baseUrl.trim()
    || draft.protocol !== baseline.protocol;
}

/** 密钥语义：非空输入在保存时替换 Provider 的 key；空 = 不动现有 key。 */
function resolveProviderSubmitState(args: {
  draft: ProviderFormDraft;
  baseline: ProviderFormBaseline;
  requiresCredentials: boolean;
  hasActiveKey: boolean;
}): ProviderSubmitState {
  const dirty = isProviderConfigDirty(args.draft, args.baseline);
  const hasRequiredCredential = !args.requiresCredentials
    || args.hasActiveKey
    || args.draft.apiKey.trim().length > 0;
  return {
    dirty,
    valid: hasRequiredCredential,
    submittable: hasRequiredCredential && dirty,
  };
}

const PROTOCOL_LABELS: Record<string, string> = {
  'openai-llm':           'OpenAI 兼容',
  'openai-responses-llm': 'OpenAI Responses',
  'anthropic-llm':        'Anthropic 兼容',
  'gemini-llm':           'Gemini',
  'openai-embed':         'OpenAI 兼容',
  'gemini-embed':         'Gemini',
  'cohere-rerank':        'Cohere 兼容',
  'openai-tts':           'OpenAI 兼容',
  'dashscope-tts':        'DashScope',
  'gpt-sovits-tts':       'GPT-SoVITS',
  'openai-stt':           'OpenAI 兼容',
};

/** 探活只支持有无输入即可验证连通性的能力（tts/stt 的功能验证是试听与转写）。 */
const PROBEABLE: ReadonlySet<ModelCapability> = new Set(['llm', 'embed', 'rerank']);

export function ProviderForm({
  provider, capability, onClose, onDirtyChange,
}: ProviderFormProps): JSX.Element {
  const [apiKey,       setApiKey]       = useState('');
  const [showApiKey,   setShowApiKey]   = useState(false);
  const [credentialDirty, setCredentialDirty] = useState(false);
  const [credentialLoaded, setCredentialLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const capabilityRow = provider.capabilities.find((c) => c.capability === capability);
  const requiresCredentials = provider.authType === 'bearer';

  // 明文密钥 30s 后自动遮蔽并清出 state。
  useEffect(() => {
    if (!showApiKey || !credentialLoaded || credentialDirty) return;
    const timer = window.setTimeout(() => {
      setShowApiKey(false);
      setCredentialLoaded(false);
      setApiKey('');
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [credentialDirty, credentialLoaded, showApiKey]);

  const protocolChoices: string[] = capabilityRow?.protocols.map((p) => p.protocol) ?? [];
  function slotUrl(proto: string): string {
    return capabilityRow?.protocols.find((p) => p.protocol === proto)?.baseUrl ?? '';
  }

  const initialProtocol = capabilityRow?.activeProtocol ?? protocolChoices[0] ?? '';
  const initialBaseline: ProviderFormBaseline = {
    baseUrl: slotUrl(initialProtocol),
    protocol: initialProtocol,
  };
  const [baseline, setBaseline] = useState<ProviderFormBaseline>(initialBaseline);
  const [selectedProtocol, setSelectedProtocol] = useState(initialBaseline.protocol);
  const [baseUrl,       setBaseUrl]       = useState(initialBaseline.baseUrl);
  const [baseUrlManual, setBaseUrlManual] = useState(false);

  function handleProtocolChange(proto: string): void {
    setSelectedProtocol(proto);
    if (!baseUrlManual) setBaseUrl(slotUrl(proto));
  }

  const [submitting, setSubmitting] = useState(false);
  const [probing,    setProbing]    = useState(false);
  const health = provider.health.find((h) => h.capability === capability);
  const [probeOk,    setProbeOk]    = useState<boolean | null>(
    health?.status === 'ok' ? true : null,
  );
  const [probeMsg, setProbeMsg] = useState<string | null>(health?.lastError ?? null);

  const submitState = resolveProviderSubmitState({
    draft: { apiKey, credentialDirty, baseUrl, protocol: selectedProtocol },
    baseline,
    requiresCredentials,
    hasActiveKey: provider.keyValue !== undefined,
  });
  const dirty = submitState.dirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const preventAccidentalClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventAccidentalClose);
    return () => window.removeEventListener('beforeunload', preventAccidentalClose);
  }, [dirty]);

  async function doSave(): Promise<void> {
    if (submitting || !submitState.submittable || !selectedProtocol) return;
    setSubmitting(true);
    try {
      const saved = await providersApi.patch(provider.id, {
        ...(apiKey.trim() ? { key: apiKey.trim() } : {}),
        capability: {
          capability,
          protocol: selectedProtocol as Protocol,
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          active: true,
        },
      });
      const savedCapability = saved.capabilities.find((c) => c.capability === capability);
      const savedProtocol = savedCapability?.activeProtocol ?? selectedProtocol;
      const savedBaseline: ProviderFormBaseline = {
        baseUrl: savedCapability?.protocols.find((p) => p.protocol === savedProtocol)?.baseUrl ?? '',
        protocol: savedProtocol,
      };
      setBaseline(savedBaseline);
      setBaseUrl(savedBaseline.baseUrl);
      setSelectedProtocol(savedBaseline.protocol);
      setBaseUrlManual(false);
      setApiKey('');
      setShowApiKey(false);
      setCredentialDirty(false);
      setCredentialLoaded(false);
      showToast('已更新', { variant: 'success' });
      await useProviderStore.getState().refreshProviders();
    } catch (err: unknown) {
      showToast(`操作失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    await doSave();
  }

  function handleCancel(): void {
    setApiKey('');
    setShowApiKey(false);
    setCredentialDirty(false);
    setCredentialLoaded(false);
    setSelectedProtocol(baseline.protocol);
    setBaseUrl(baseline.baseUrl);
    setBaseUrlManual(false);
    setProbeOk(health?.status === 'ok' ? true : null);
    setProbeMsg(health?.lastError ?? null);
  }

  function handleCredentialVisibility(): void {
    if (showApiKey) {
      setShowApiKey(false);
      if (credentialLoaded && !credentialDirty) {
        setApiKey('');
        setCredentialLoaded(false);
      }
      return;
    }

    if (credentialDirty || credentialLoaded) {
      setShowApiKey(true);
      return;
    }

    // keyValue 是凭据边界的全文投影；一个 Provider 只有一把，直接读。
    if (!provider.keyValue) {
      showToast('尚未配置密钥', { variant: 'warning' });
      return;
    }
    setApiKey(provider.keyValue);
    setCredentialLoaded(true);
    setShowApiKey(true);
  }

  async function handleProbe(): Promise<void> {
    if (!PROBEABLE.has(capability)) return;
    setProbing(true);
    try {
      const result = await providersApi.probe(
        provider.id,
        capability as 'llm' | 'embed' | 'rerank',
      );
      setProbeOk(result.ok);
      setProbeMsg(result.ok ? null : result.error);
    } catch (err) {
      setProbeOk(false);
      setProbeMsg('探测失败' + (err instanceof Error ? `: ${err.message}` : ''));
    } finally {
      setProbing(false);
    }
  }

  const protocolOptions = protocolChoices.map((proto) => ({
    value: proto,
    label: PROTOCOL_LABELS[proto] ?? proto,
  }));

  return (
    <div className="flex flex-col gap-8 pb-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-8 max-w-lg">

        {/* ── 基础配置 ──────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-6">
          <div>
            <h2 className="text-2xl text-[var(--ema-text-primary)]">基础配置</h2>
            <p className="text-sm text-[var(--ema-text-tertiary)] mt-0.5">基本设置</p>
          </div>

          {requiresCredentials && <div className="flex flex-col gap-2">
            <div>
              <div className="text-sm font-medium text-[var(--ema-text-secondary)]">API 密钥</div>
              <div className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
                API Key for {provider.name}
              </div>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder={provider.keyValue !== undefined ? '已配置；输入新密钥可替换' : 'sk-...'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setCredentialDirty(true);
                  setCredentialLoaded(false);
                }}
                autoComplete="off"
                maxLength={PROVIDER_LIMITS.apiKeyChars}
                className="pr-10"
              />
              <IconButton
                label={showApiKey ? '隐藏密钥' : '显示密钥'}
                icon={showApiKey ? 'i-solar:eye-closed-linear' : 'i-solar:eye-linear'}
                size="sm"
                type="button"
                tabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
                onClick={handleCredentialVisibility}
              />
            </div>
          </div>}
        </section>

        {/* ── 高级配置(默认折叠)────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-left outline-none group"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <h2 className="text-2xl text-[var(--ema-text-primary)] group-hover:text-[var(--ema-text-secondary)] transition-colors duration-[var(--ema-duration-base)]">
              高级配置
            </h2>
            <span
              className="i-solar:alt-arrow-down-linear text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-text-secondary)] transition-transform duration-[var(--ema-duration-base)]"
              style={{ transform: advancedOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              aria-hidden
            />
          </button>

          <div className="ema-collapsible" style={{ gridTemplateRows: advancedOpen ? '1fr' : '0fr' }}>
            <div className="overflow-hidden flex flex-col gap-4 mt-1">
              {protocolChoices.length > 1 && (
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-medium text-[var(--ema-text-secondary)]">协议</div>
                  <Select
                    value={selectedProtocol}
                    onChange={handleProtocolChange}
                    options={protocolOptions}
                  />
                </div>
              )}

              <div className="flex flex-col gap-2">
                <div>
                  <div className="text-sm font-medium text-[var(--ema-text-secondary)]">Base URL</div>
                  <div className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">自定义服务地址(可选)</div>
                </div>
                <Input
                  placeholder={slotUrl(selectedProtocol) || 'https://...'}
                  value={baseUrl}
                  maxLength={PROVIDER_LIMITS.baseUrlChars}
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlManual(true); }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── 验证状态条 ────────────────────────────────────────────────────── */}
        {probeOk === false && probeMsg && (
          <div className="flex items-center justify-between rounded-lg
                          bg-[var(--ema-danger-muted)] border border-[var(--ema-danger)]
                          px-3 py-2 text-sm text-[var(--ema-danger-text)]">
            <div className="flex items-center gap-2">
              <span className="i-solar:danger-circle-linear shrink-0" aria-hidden />
              <span>{probeMsg}</span>
            </div>
            {PROBEABLE.has(capability) && (
              <Button
                variant="danger"
                size="sm"
                loading={probing}
                disabled={probing || dirty}
                type="button"
                onClick={() => void handleProbe()}
              >
                Ping API
              </Button>
            )}
          </div>
        )}
        {probeOk !== false && (
          <Callout variant="info">
            <div className="flex items-center justify-between">
              <span>{probeOk === true ? '配置验证通过' : '配置部分验证'}</span>
              {PROBEABLE.has(capability) && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={probing}
                  disabled={probing || dirty}
                  type="button"
                  onClick={() => void handleProbe()}
                >
                  Ping API
                </Button>
              )}
            </div>
          </Callout>
        )}

        {/* 保存栏属于 Provider 配置，固定放在模型池之前，避免与模型管理操作混淆。 */}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--ema-border)] pt-4">
          <span className="text-xs text-[var(--ema-text-tertiary)]">
            {!submitState.valid
              ? '请填写 API Key'
              : dirty ? '有未保存的更改' : '配置已保存'}
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={submitting || !submitState.submittable}
            >
              保存更改
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting || !dirty}
              onClick={handleCancel}
            >
              取消
            </Button>
          </div>
        </div>

      </form>

      {/* ── 模型池 ───────────────────────────────────────────────────────────── */}
      <div className="border-t border-[var(--ema-border)]" />
      <ProviderModelManager
        providerId={provider.id}
        capability={capability}
        iconKey={resolveProviderIconClass(provider.iconId)}
      />
    </div>
  );
}
