/** ProviderForm — AIRI-style provider editor. */
import { useState, useEffect, type FormEvent, type JSX } from 'react';
import { Button, Callout, IconButton, Input, Select } from '@ema-agent/ui';
import { useSettingsStore } from '../stores/settings-store.js';
import {
  providersApi,
  type ProviderConfigWire,
  type ProviderConfigInput,
  type ProviderDefinition,
} from '../api/providers.js';
import type { ProtocolFamily, Capability } from '@ema-agent/contracts';
import { resolveProtocols } from '@ema-agent/contracts';
import { showToast } from '../lib/toast.js';
import { LlmModelManager }    from './LlmModelManager.js';
import { EmbedModelManager }  from './EmbedModelManager.js';
import { RerankModelManager } from './RerankModelManager.js';
import { TtsModelManager }    from './TtsModelManager.js';
import { SttModelManager }    from './SttModelManager.js';

export interface ProviderFormProps {
  definitionId: string;
  definition?:  ProviderDefinition;
  capability?:  Capability;
  instance?:    ProviderConfigWire;
  onClose():    void;
}

const PROTOCOL_LABELS: Record<string, string> = {
  'openai-llm':           'OpenAI 兼容',
  'openai-responses-llm': 'OpenAI Responses',
  'anthropic-llm':        'Anthropic 兼容',
  'gemini-llm':           'Gemini',
};

export function ProviderForm({
  definitionId, definition, capability, instance, onClose,
}: ProviderFormProps): JSX.Element {
  const [apiKey,       setApiKey]       = useState('');
  const [showApiKey,   setShowApiKey]   = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const activeCap: Capability | undefined = capability ?? definition?.capabilities?.[0];

  useEffect(() => {
    if (!instance) return;
    let cancelled = false;
    void providersApi.getKey(instance.id)
      .then((k) => { if (!cancelled) setApiKey(k); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [instance]);

  const protocolChoices: string[] = activeCap
    ? resolveProtocols(definition?.protocols?.[activeCap])
    : [];
  const existingProtocol = (instance?.config?.['protocol'] as string | undefined)
    ?? protocolChoices[0] ?? '';
  const [selectedProtocol, setSelectedProtocol] = useState(existingProtocol);

  function defaultUrlFor(proto: string): string {
    return definition?.protocolBaseUrls?.[proto as ProtocolFamily]
      ?? definition?.defaultBaseUrl ?? '';
  }
  const [baseUrl,       setBaseUrl]       = useState(instance?.baseUrl ?? defaultUrlFor(existingProtocol));
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

  async function doSave(): Promise<void> {
    if (!instance && !apiKey.trim()) return;
    setSubmitting(true);
    try {
      const input: ProviderConfigInput = {
        definitionId,
        apiKey:  apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || null,
        config:  { ...(selectedProtocol ? { protocol: selectedProtocol } : {}) },
      };
      if (instance) {
        await providersApi.patch(instance.id, input);
        showToast('已更新', { variant: 'success' });
      } else {
        await providersApi.create(input);
        showToast('已创建', { variant: 'success' });
      }
      void useSettingsStore.getState().refreshProviders();
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

  async function handleProbe(): Promise<void> {
    if (!instance) return;
    setProbing(true);
    try {
      const result = await providersApi.probe(instance.id, undefined);
      setProbeOk(result.ok);
      setProbeMsg(result.ok ? null : (result.error ?? '连接失败'));
    } catch {
      setProbeOk(false);
      setProbeMsg('探测失败');
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
            <h2 className="text-2xl text-[var(--ema-text-tertiary)]">基础配置</h2>
            <p className="text-sm text-[var(--ema-text-tertiary)] mt-0.5">基本设置</p>
          </div>

          <div className="flex flex-col gap-2">
            <div>
              <div className="text-sm font-medium text-[var(--ema-text-secondary)]">API 密钥</div>
              <div className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
                API Key for {definition?.name ?? definitionId}
              </div>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => { void doSave(); }}
                autoComplete="off"
                className="pr-10"
              />
              <IconButton
                label={showApiKey ? '隐藏密钥' : '显示密钥'}
                icon={showApiKey ? 'i-solar:eye-closed-linear' : 'i-solar:eye-linear'}
                size="sm"
                type="button"
                tabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
                onClick={() => setShowApiKey((v) => !v)}
              />
            </div>
          </div>
        </section>

        {/* ── 高级配置(默认折叠)────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-left outline-none group"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <h2 className="text-2xl text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-text-secondary)] transition-colors duration-[var(--ema-duration-base)]">
              高级配置
            </h2>
            <span
              className="i-solar:alt-arrow-down-linear text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-text-secondary)] transition-transform duration-[var(--ema-duration-base)]"
              style={{ transform: advancedOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              aria-hidden
            />
          </button>

          {advancedOpen && (
            <div className="flex flex-col gap-4 mt-1">
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
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlManual(true); }}
                />
              </div>
            </div>
          )}
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
            {activeCap === 'llm' && (
              <Button
                variant="danger"
                size="sm"
                loading={probing}
                disabled={probing}
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
              {activeCap === 'llm' && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={probing}
                  disabled={probing}
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
          <Callout variant="info">输入 API Key 后自动保存</Callout>
        )}

      </form>

      {/* ── 模型池 ───────────────────────────────────────────────────────────── */}
      {instance && activeCap === 'llm' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <LlmModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'embed' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <EmbedModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'rerank' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <RerankModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'tts' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <TtsModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'stt' && (
        <>
          <div className="border-t border-[var(--ema-border)]" />
          <SttModelManager providerId={instance.id} />
        </>
      )}
    </div>
  );
}
