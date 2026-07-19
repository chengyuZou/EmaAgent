/** ProviderForm — AIRI-style provider editor. */
import { useState, useEffect, type FormEvent, type JSX } from 'react';
import { Button, Callout, IconButton, Input, Select } from '@ema-agent/ui';
import { useSettingsStore } from '../stores/settings-store.js';
import {
  providersApi,
  type ProviderConfigWire,
  type ProviderConfigInput,
  type ProviderConfigPatchInput,
  type ProviderDefinition,
  type ProbeResultWire,
} from '../api/providers.js';
import {
  PROVIDER_CONFIG_LIMITS,
  resolveProtocols,
  type ProtocolFamily,
  type Capability,
} from '@ema-agent/contracts';
import { showToast } from '../lib/toast.js';
import {
  resolveCredentialOperation,
  resolveProviderSubmitState,
  type ProviderFormSnapshot,
} from './provider-form-state.js';
import { LlmModelManager }    from './LlmModelManager.js';
import { EmbedModelManager }  from './EmbedModelManager.js';
import { RerankModelManager } from './RerankModelManager.js';
import { TtsModelManager }    from './TtsModelManager.js';
import { SttModelManager }    from './SttModelManager.js';
import { VisionModelManager } from './VisionModelManager.js';

export interface ProviderFormProps {
  definitionId: string;
  definition?:  ProviderDefinition;
  capability?:  Capability;
  instance?:    ProviderConfigWire;
  onClose():    void;
  onDirtyChange?(dirty: boolean): void;
}

const PROTOCOL_LABELS: Record<string, string> = {
  'openai-llm':           'OpenAI 兼容',
  'openai-responses-llm': 'OpenAI Responses',
  'anthropic-llm':        'Anthropic 兼容',
  'gemini-llm':           'Gemini',
};

export function ProviderForm({
  definitionId, definition, capability, instance, onClose, onDirtyChange,
}: ProviderFormProps): JSX.Element {
  const [apiKey,       setApiKey]       = useState('');
  const [showApiKey,   setShowApiKey]   = useState(false);
  const [credentialDirty, setCredentialDirty] = useState(false);
  const [credentialLoaded, setCredentialLoaded] = useState(false);
  const [revealingCredential, setRevealingCredential] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const activeCap: Capability | undefined = capability ?? definition?.capabilities?.[0];
  const requiresCredentials = definition?.requiresCredentials !== false;

  useEffect(() => {
    if (!instance || !showApiKey || !credentialLoaded || credentialDirty) return;
    const timer = window.setTimeout(() => {
      setShowApiKey(false);
      setCredentialLoaded(false);
      setApiKey('');
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [credentialDirty, credentialLoaded, instance, showApiKey]);

  const protocolChoices: string[] = activeCap
    ? resolveProtocols(definition?.protocols?.[activeCap])
    : [];
  function defaultUrlFor(proto: string): string {
    return definition?.protocolBaseUrls?.[proto as ProtocolFamily]
      ?? definition?.defaultBaseUrl ?? '';
  }

  const existingProtocol = (instance?.config?.['protocol'] as string | undefined)
    ?? protocolChoices[0] ?? '';
  const initialSnapshot: ProviderFormSnapshot = {
    baseUrl: instance?.baseUrl ?? defaultUrlFor(existingProtocol),
    protocol: existingProtocol,
  };
  const [snapshot, setSnapshot] = useState<ProviderFormSnapshot>(initialSnapshot);
  const [selectedProtocol, setSelectedProtocol] = useState(initialSnapshot.protocol);
  const [baseUrl,       setBaseUrl]       = useState(initialSnapshot.baseUrl);
  const [baseUrlManual, setBaseUrlManual] = useState(false);

  function handleProtocolChange(proto: string): void {
    setSelectedProtocol(proto);
    if (!baseUrlManual) setBaseUrl(defaultUrlFor(proto));
  }

  const [submitting, setSubmitting] = useState(false);
  const [probing,    setProbing]    = useState(false);
  const [probeOk,    setProbeOk]    = useState<boolean | null>(
    instance?.health?.status === 'ok' ? true : null,
  );
  const [probeMsg, setProbeMsg] = useState<string | null>(instance?.health?.lastError ?? null);

  const submitState = resolveProviderSubmitState({
    draft: { apiKey, credentialDirty, baseUrl, protocol: selectedProtocol },
    snapshot,
    existing: instance !== undefined,
    requiresCredentials,
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
    if (submitting || !submitState.submittable) return;
    setSubmitting(true);
    try {
      if (instance) {
        const input: ProviderConfigPatchInput = {
          credential: resolveCredentialOperation(apiKey, credentialDirty),
          baseUrl: baseUrl.trim() || null,
          config:  {
            ...instance.config,
            ...(selectedProtocol ? { protocol: selectedProtocol } : {}),
          },
        };
        const saved = await providersApi.patch(instance.id, input);
        const savedProtocol = (saved.config['protocol'] as string | undefined)
          ?? selectedProtocol;
        const savedSnapshot: ProviderFormSnapshot = {
          baseUrl: saved.baseUrl ?? defaultUrlFor(savedProtocol),
          protocol: savedProtocol,
        };
        setSnapshot(savedSnapshot);
        setBaseUrl(savedSnapshot.baseUrl);
        setSelectedProtocol(savedSnapshot.protocol);
        setBaseUrlManual(false);
        setApiKey('');
        setShowApiKey(false);
        setCredentialDirty(false);
        setCredentialLoaded(false);
        showToast('已更新', { variant: 'success' });
      } else {
        const input: ProviderConfigInput = {
          definitionId,
          apiKey:  apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || null,
          config:  { ...(selectedProtocol ? { protocol: selectedProtocol } : {}) },
        };
        await providersApi.create(input);
        showToast('已创建', { variant: 'success' });
      }
      await useSettingsStore.getState().refreshProviders();
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
    if (!instance) {
      onClose();
      return;
    }
    setApiKey('');
    setShowApiKey(false);
    setCredentialDirty(false);
    setCredentialLoaded(false);
    setSelectedProtocol(snapshot.protocol);
    setBaseUrl(snapshot.baseUrl);
    setBaseUrlManual(false);
    setProbeOk(instance.health?.status === 'ok' ? true : null);
    setProbeMsg(instance.health?.lastError ?? null);
  }

  async function handleCredentialVisibility(): Promise<void> {
    if (showApiKey) {
      setShowApiKey(false);
      if (instance && credentialLoaded && !credentialDirty) {
        setApiKey('');
        setCredentialLoaded(false);
      }
      return;
    }

    if (!instance || credentialDirty || credentialLoaded) {
      setShowApiKey(true);
      return;
    }

    setRevealingCredential(true);
    try {
      const credential = await providersApi.revealCredential(instance.id);
      setApiKey(credential);
      setCredentialLoaded(true);
      setShowApiKey(true);
    } catch (err: unknown) {
      showToast(`读取密钥失败: ${err instanceof Error ? err.message : 'Unknown'}`, {
        variant: 'danger',
      });
    } finally {
      setRevealingCredential(false);
    }
  }

  async function handleProbe(): Promise<void> {
    if (!instance || !activeCap) return;
    setProbing(true);
    try {
      // Each capability has its own probe endpoint — the old single endpoint
      // dispatched by capabilities-array order, so probing OpenAI from the
      // Embed section hit LLM first. Per-capability dispatch fixes that.
      const result = await (
        activeCap === 'llm'    ? providersApi.probeLlm(instance.id)
      : activeCap === 'vision' ? providersApi.probeVision(instance.id)
      : activeCap === 'embed'  ? providersApi.probeEmbed(instance.id)
      : activeCap === 'rerank' ? providersApi.probeRerank(instance.id)
      : activeCap === 'tts'    ? providersApi.probeTts(instance.id)
      : activeCap === 'stt'    ? providersApi.probeStt(instance.id)
      : Promise.resolve<ProbeResultWire>({ ok: false, model: '', latencyMs: null, error: '该能力不支持探测' })
      );
      setProbeOk(result.ok);
      setProbeMsg(result.ok ? null : (result.error ?? '连接失败'));
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
                API Key for {definition?.name ?? definitionId}
              </div>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder={instance?.hasApiKey ? '已配置；输入新密钥可替换' : 'sk-...'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setCredentialDirty(true);
                  setCredentialLoaded(false);
                }}
                autoComplete="off"
                maxLength={PROVIDER_CONFIG_LIMITS.apiKeyChars}
                className="pr-10"
              />
              <IconButton
                label={showApiKey ? '隐藏密钥' : '显示密钥'}
                icon={showApiKey ? 'i-solar:eye-closed-linear' : 'i-solar:eye-linear'}
                size="sm"
                type="button"
                disabled={revealingCredential}
                tabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
                onClick={() => { void handleCredentialVisibility(); }}
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
                  placeholder={defaultUrlFor(selectedProtocol) || 'https://...'}
                  value={baseUrl}
                  maxLength={PROVIDER_CONFIG_LIMITS.baseUrlChars}
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlManual(true); }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── 验证状态条 ────────────────────────────────────────────────────── */}
        {instance && probeOk === false && probeMsg && (
          <div className="flex items-center justify-between rounded-lg
                          bg-[var(--ema-danger-muted)] border border-[var(--ema-danger)]
                          px-3 py-2 text-sm text-[var(--ema-danger-text)]">
            <div className="flex items-center gap-2">
              <span className="i-solar:danger-circle-linear shrink-0" aria-hidden />
              <span>{probeMsg}</span>
            </div>
            {activeCap && (
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
        {instance && probeOk !== false && (
          <Callout variant="info">
            <div className="flex items-center justify-between">
              <span>{probeOk === true ? '配置验证通过' : '配置部分验证'}</span>
              {activeCap && (
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
        {!instance && (
          <Callout variant="info">填写配置后，点击“创建服务来源”保存</Callout>
        )}

        {/* 保存栏属于 Provider 配置，固定放在模型池之前，避免与模型管理操作混淆。 */}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--ema-border)] pt-4">
          <span className="text-xs text-[var(--ema-text-tertiary)]">
            {!submitState.valid
              ? '请填写 API Key'
              : instance
                ? dirty ? '有未保存的更改' : '配置已保存'
                : '尚未创建服务来源'}
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={submitting || !submitState.submittable}
            >
              {instance ? '保存更改' : '创建服务来源'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting || (instance !== undefined && !dirty)}
              onClick={handleCancel}
            >
              取消
            </Button>
          </div>
        </div>

      </form>

      {/* ── 模型池 ───────────────────────────────────────────────────────────── */}
      {instance && activeCap === 'llm' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <LlmModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
      {instance && activeCap === 'embed' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <EmbedModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
      {instance && activeCap === 'rerank' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <RerankModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
      {instance && activeCap === 'tts' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <TtsModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
      {instance && activeCap === 'stt' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <SttModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
      {instance && activeCap === 'vision' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <VisionModelManager providerId={instance.id} iconKey={definition?.iconKey} />
        </>
      )}
    </div>
  );
}
