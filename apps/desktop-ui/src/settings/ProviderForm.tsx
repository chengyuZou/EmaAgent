/** ProviderForm — AIRI-style provider editor. */
import { useState, useEffect, type FormEvent } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { providersApi, type ProviderConfigWire, type ProviderConfigInput, type ProviderDefinition } from '../api/providers.js';
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

const inputCls = 'w-full bg-neutral-900/80 backdrop-blur-sm border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-pink-400/40 transition-all duration-250';

export function ProviderForm({ definitionId, definition, capability, instance, onClose }: ProviderFormProps): JSX.Element {
  const [apiKey, setApiKey]         = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
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
  const [baseUrl, setBaseUrl]           = useState(instance?.baseUrl ?? defaultUrlFor(existingProtocol));
  const [baseUrlManual, setBaseUrlManual] = useState(false);

  function handleProtocolChange(proto: string): void {
    setSelectedProtocol(proto);
    if (!baseUrlManual) setBaseUrl(defaultUrlFor(proto));
  }

  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing]       = useState(false);
  const [probeOk, setProbeOk]       = useState<boolean | null>(instance?.health?.status === 'ok' ? true : null);
  const [probeMsg, setProbeMsg]     = useState<string | null>(instance?.health?.lastError ?? null);

  async function doSave(): Promise<void> {
    if (!instance && !apiKey.trim()) return; // need key for first create
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

  return (
    <div className="flex flex-col gap-8 pb-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-8 max-w-lg">

        {/* ── 基础配置 ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-2xl text-neutral-400">基础配置</h2>
              <p className="text-sm text-neutral-500 mt-0.5">基本设置</p>
            </div>
          </div>

          {/* API 密钥 */}
          <label className="flex flex-col gap-2">
            <div>
              <div className="text-sm font-medium text-neutral-300">API 密钥</div>
              <div className="text-xs text-neutral-500 mt-0.5">
                API Key for {definition?.name ?? definitionId}
              </div>
            </div>
            <div className="relative">
              <input
                className={`${inputCls} pr-10`}
                placeholder="sk-..."
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => { void doSave(); }}
                autoComplete="off"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors px-1"
                tabIndex={-1}
                onClick={() => setShowApiKey((v) => !v)}
                aria-label={showApiKey ? '隐藏' : '显示明文'}
              >
                <span className={showApiKey ? 'i-solar:eye-closed-linear' : 'i-solar:eye-linear'} aria-hidden />
              </button>
            </div>
          </label>
        </section>

        {/* ── 高级配置（默认折叠）─────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-left outline-none group bg-transparent border-0 focus:ring-0 focus-visible:ring-0"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <h2 className="text-2xl text-neutral-400 group-hover:text-neutral-300 transition-colors duration-200">高级配置</h2>
            <span
              className="i-solar:alt-arrow-down-linear text-neutral-500 group-hover:text-neutral-400 transition-transform duration-200"
              style={{ transform: advancedOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              aria-hidden
            />
          </button>

          {advancedOpen && (
            <div className="flex flex-col gap-4 mt-1">
              {protocolChoices.length > 1 && (
                <label className="flex flex-col gap-2">
                  <div>
                    <div className="text-sm font-medium text-neutral-300">协议</div>
                  </div>
                  <select
                    className={inputCls}
                    value={selectedProtocol}
                    onChange={(e) => handleProtocolChange(e.target.value)}
                  >
                    {protocolChoices.map((proto) => (
                      <option key={proto} value={proto}>{PROTOCOL_LABELS[proto] ?? proto}</option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-2">
                <div>
                  <div className="text-sm font-medium text-neutral-300">Base URL</div>
                  <div className="text-xs text-neutral-500 mt-0.5">自定义服务地址（可选）</div>
                </div>
                <input
                  className={inputCls}
                  placeholder={defaultUrlFor(selectedProtocol) || 'https://...'}
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlManual(true); }}
                />
              </label>
            </div>
          )}
        </section>

        {/* ── 验证状态条（Ping 内嵌）──────────────────────────────────────── */}
        {instance && probeOk === false && probeMsg && (
          <div className="flex items-center justify-between rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
            <div className="flex items-center gap-2">
              <span className="i-solar:danger-circle-linear shrink-0" aria-hidden />
              <span>{probeMsg}</span>
            </div>
            {activeCap === 'llm' && (
              <button type="button" disabled={probing} onClick={handleProbe}
                className="ml-4 rounded px-2 py-0.5 text-xs font-medium bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors disabled:opacity-50">
                {probing ? '测试中…' : 'Ping API'}
              </button>
            )}
          </div>
        )}
        {instance && probeOk !== false && (
          <div className="flex items-center justify-between rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-sm text-blue-300">
            <div className="flex items-center gap-2">
              <span className="i-solar:info-circle-linear shrink-0" aria-hidden />
              <span>{probeOk === true ? '配置验证通过' : '配置部分验证'}</span>
            </div>
            {activeCap === 'llm' && (
              <button type="button" disabled={probing} onClick={handleProbe}
                className="ml-4 rounded px-2 py-0.5 text-xs font-medium bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 transition-colors disabled:opacity-50">
                {probing ? '测试中…' : 'Ping API'}
              </button>
            )}
          </div>
        )}
        {!instance && (
          <div className="flex items-center rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-sm text-blue-300">
            <span className="i-solar:info-circle-linear mr-2 shrink-0" aria-hidden />
            <span>输入 API Key 后自动保存</span>
          </div>
        )}

      </form>

      {/* ── 模型池（配置存在后才显示）──────────────────────────────────────── */}
      {instance && activeCap === 'llm' && (
        <>
          <div className="border-t border-neutral-800" />
          <LlmModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'embed' && (
        <>
          <div className="border-t border-neutral-800" />
          <EmbedModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'rerank' && (
        <>
          <div className="border-t border-neutral-800" />
          <RerankModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'tts' && (
        <>
          <div className="border-t border-neutral-800" />
          <TtsModelManager providerId={instance.id} />
        </>
      )}
      {instance && activeCap === 'stt' && (
        <>
          <div className="border-t border-neutral-800" />
          <SttModelManager providerId={instance.id} />
        </>
      )}
    </div>
  );
}
