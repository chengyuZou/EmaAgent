/** ProviderForm — add/edit a provider instance. */
import { useState, type FormEvent } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { providersApi, type ProviderConfigWire, type ProviderConfigInput, type ProviderDefinitionWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export interface ProviderFormProps {
  definitionId: string;
  definition?:  ProviderDefinitionWire;
  instance?:    ProviderConfigWire;
  onClose():    void;
}

export function ProviderForm({ definitionId, definition, instance, onClose }: ProviderFormProps): JSX.Element {
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // ── TTS-specific fields ─────────────────────────────────────────────────
  const hasTts = definition?.capabilities?.includes('tts') ?? false;
  const ttsModels: string[] = (definition?.defaultModels?.['tts'] as string[]) ?? [];
  const [ttsModel, setTtsModel] = useState(instance?.config?.['ttsModel'] as string ?? ttsModels[0] ?? '');
  const [ttsSpeed, setTtsSpeed] = useState(instance?.config?.['ttsSpeed'] as number ?? 1.0);
  const [ttsVoice, setTtsVoice] = useState(instance?.config?.['ttsVoice'] as string ?? '');
  const [ttsTestText, setTtsTestText] = useState('你好，我是艾玛，很高兴认识你。');
  const [ttsTesting, setTtsTesting] = useState(false);

  // ── Protocol selection ──────────────────────────────────────────────────
  // Find the first capability that offers multiple protocols. When present,
  // the user can pick which wire protocol to use (e.g. DeepSeek supports
  // openai-llm and anthropic-llm on different base URLs).
  const capabilityEntries = Object.entries(definition?.protocols ?? {}) as [string, string | string[]][];
  const multiCap = capabilityEntries.find(([, v]) => Array.isArray(v) && (v as string[]).length > 1);
  const protocolChoices: string[] = multiCap
    ? (multiCap[1] as string[])
    : (capabilityEntries.length > 0 && typeof capabilityEntries[0]![1] === 'string'
      ? [capabilityEntries[0]![1] as string]
      : []);

  const existingProtocol = (instance?.config?.['protocol'] as string | undefined)
    ?? protocolChoices[0]
    ?? '';
  const [selectedProtocol, setSelectedProtocol] = useState(existingProtocol);

  // Default baseUrl: editing → saved value; new → protocolBaseUrl or defaultBaseUrl
  function defaultUrlFor(proto: string): string {
    return definition?.protocolBaseUrls?.[proto]
      ?? definition?.defaultBaseUrl
      ?? '';
  }
  const [baseUrl, setBaseUrl] = useState(
    instance?.baseUrl ?? defaultUrlFor(existingProtocol),
  );
  // Track whether the user has manually edited baseUrl so we don't overwrite
  const [baseUrlManual, setBaseUrlManual] = useState(false);

  function handleProtocolChange(proto: string): void {
    setSelectedProtocol(proto);
    if (!baseUrlManual) {
      setBaseUrl(defaultUrlFor(proto));
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────

  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();

    // New instance: API key is required
    if (!instance && !apiKey.trim()) {
      showToast('API Key 不能为空', { variant: 'danger' });
      return;
    }

    setSubmitting(true);
    try {
      const input: ProviderConfigInput = {
        definitionId,
        displayName: displayName || undefined,
        apiKey:      apiKey.trim() || undefined,
        baseUrl:     baseUrl.trim() || null,
        config:      {
          ...(selectedProtocol ? { protocol: selectedProtocol } : {}),
          ...(hasTts ? { ttsModel, ttsSpeed, ttsVoice } : {}),
        },
      };

      if (instance) {
        await providersApi.patch(instance.id, input);
        showToast('已更新', { variant: 'success' });
      } else {
        await providersApi.create(input);
        showToast('已创建', { variant: 'success' });
      }

      void useSettingsStore.getState().refreshProviders();
      onClose();
    } catch (err: unknown) {
      showToast(`操作失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProbe(): Promise<void> {
    try {
      const result = await providersApi.probe(instance?.id ?? '', undefined);
      showToast(result.ok ? `连接成功 ${result.latencyMs}ms` : `连接失败: ${result.error}`, {
        variant: result.ok ? 'success' : 'danger',
      });
    } catch {
      showToast('探测失败', { variant: 'danger' });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-2xl p-4">
      <h3 className="text-sm font-semibold mb-3">{instance ? '编辑实例' : '新增实例'}</h3>

      <div className="flex flex-col gap-3">
        <input
          className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          placeholder="显示名称（可选）"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        {/* API Key with show/hide toggle */}
        <div className="relative">
          <input
            className="w-full bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 pr-10 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
            placeholder={instance ? 'API Key（留空则不修改）' : 'API Key *'}
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors px-1"
            tabIndex={-1}
            onClick={() => setShowApiKey((v) => !v)}
            title={showApiKey ? '隐藏' : '显示明文'}
          >
            {showApiKey ? '🙈' : '👁'}
          </button>
        </div>

        {/* Protocol selector — shown when provider has multiple protocols for one capability */}
        {protocolChoices.length > 1 && (
          <select
            className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
            value={selectedProtocol}
            onChange={(e) => handleProtocolChange(e.target.value)}
          >
            {protocolChoices.map((proto) => (
              <option key={proto} value={proto}>{proto}</option>
            ))}
          </select>
        )}

        <input
          className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          placeholder="Base URL（可选）"
          value={baseUrl}
          onChange={(e) => { setBaseUrl(e.target.value); setBaseUrlManual(true); }}
        />

        {/* ── TTS-specific fields ────────────────────────────────────────── */}
        {hasTts && (
          <>
            {ttsModels.length > 0 && (
              <select
                className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
                value={ttsModel}
                onChange={(e) => setTtsModel(e.target.value)}
              >
                {ttsModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <span>语速</span>
              <input
                type="range" min={0.25} max={2.0} step={0.05}
                className="flex-1 accent-pink-400"
                value={ttsSpeed}
                onChange={(e) => setTtsSpeed(parseFloat(e.target.value))}
              />
              <span className="w-10 text-right text-gray-200">{ttsSpeed.toFixed(2)}</span>
            </div>
            <input
              className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
              placeholder="语音 ID（可选，如 alloy）"
              value={ttsVoice}
              onChange={(e) => setTtsVoice(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
                placeholder="测试文本"
                value={ttsTestText}
                onChange={(e) => setTtsTestText(e.target.value)}
              />
              <button
                type="button"
                disabled={ttsTesting || !instance}
                className="px-3 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 disabled:opacity-50"
                onClick={async () => {
                  if (!instance) return;
                  setTtsTesting(true);
                  try {
                    const res = await providersApi.probe(instance.id, ttsModel);
                    showToast(res.ok ? `测试成功 ${res.latencyMs}ms` : `测试失败: ${res.error}`, {
                      variant: res.ok ? 'success' : 'danger',
                    });
                  } catch {
                    showToast('测试失败', { variant: 'danger' });
                  } finally { setTtsTesting(false); }
                }}
              >{ttsTesting ? '测试中…' : '测试声音'}</button>
            </div>
          </>
        )}
      </div>

      <div className="flex gap-2 mt-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors disabled:opacity-50"
        >
          {submitting ? '保存中…' : '保存'}
        </button>
        {instance && (
          <button
            type="button"
            className="px-3 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600"
            onClick={handleProbe}
          >测试连接</button>
        )}
        <button
          type="button"
          className="px-3 py-2 rounded-xl text-gray-400 text-sm hover:text-gray-200"
          onClick={onClose}
        >取消</button>
      </div>
    </form>
  );
}
