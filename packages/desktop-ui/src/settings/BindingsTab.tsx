/**
 * BindingsTab — 13 BindingModule → list of (provider + model) bindings.
 */
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { modelBindingsApi, type BindingModule, type ResolvedModelBinding } from '../api/model-bindings.js';
import type { Capability } from '@ema-agent/contracts';
import { showToast } from '../lib/toast.js';

/** Maps each binding module to the provider capability it requires. */
const MODULE_CAPABILITY: Record<BindingModule, string> = {
  chat:           'llm',
  narrative:      'llm',
  agent:          'llm',
  compaction:     'llm',
  emotion:        'llm',
  memory:         'llm',
  router:         'llm',
  'plan-parse':   'llm',
  title:          'llm',
  'lightrag-llm': 'llm',
  embed:          'embed',
  rerank:         'rerank',
  tts:            'tts',
  stt:            'stt',
  vision:         'vision',
  imagegen:       'vision',
};

const MODULES: Array<{ id: BindingModule; label: string }> = [
  { id: 'chat',          label: 'Chat' },
  { id: 'narrative',     label: 'Narrative' },
  { id: 'agent',         label: 'Agent' },
  { id: 'compaction',    label: 'Compaction' },
  { id: 'emotion',       label: 'Emotion' },
  { id: 'memory',        label: 'Memory' },
  { id: 'router',        label: 'Router' },
  { id: 'plan-parse',    label: 'Plan Parse' },
  { id: 'title',         label: 'Title' },
  { id: 'embed',         label: 'Embed' },
  { id: 'rerank',        label: 'Rerank' },
  { id: 'lightrag-llm',  label: 'LightRAG LLM' },
  { id: 'tts',           label: 'TTS' },
  { id: 'stt',           label: 'STT' },
  { id: 'vision',        label: 'Vision' },
  { id: 'imagegen',      label: 'Image Gen' },
];

export function BindingsTab(): JSX.Element {
  const [activeModule, setActiveModule] = useState<BindingModule>('chat');
  const [bindings, setBindings] = useState<ResolvedModelBinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addProviderId, setAddProviderId] = useState('');
  const [addModel, setAddModel] = useState('');
  /** When true, the model field is free-text instead of picking from the registry. */
  const [addModelCustom, setAddModelCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const allProviders = useSettingsStore((s) => s.providers);

  // Only show providers that support this module's required capability
  const requiredCap = MODULE_CAPABILITY[activeModule];
  const providers = allProviders.filter((p) => p.capabilities.includes(requiredCap));

  useEffect(() => {
    setLoading(true);
    setShowAdd(false);
    void modelBindingsApi.listByModule(activeModule)
      .then(setBindings)
      .catch(() => setBindings([]))
      .finally(() => setLoading(false));
  }, [activeModule]);

  async function handleDelete(pcId: string, model: string): Promise<void> {
    try {
      await modelBindingsApi.delete(activeModule, pcId, model);
      const updated = await modelBindingsApi.listByModule(activeModule);
      setBindings(updated);
      showToast('已删除', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  async function handleAdd(): Promise<void> {
    if (!addProviderId) {
      showToast('请选择 Provider', { variant: 'danger' });
      return;
    }
    if (!addModel.trim()) {
      showToast('模型名称不能为空', { variant: 'danger' });
      return;
    }
    setSaving(true);
    try {
      const updated = await modelBindingsApi.upsert(activeModule, {
        providerConfigId: addProviderId,
        model: addModel.trim(),
      });
      setBindings(updated);
      setShowAdd(false);
      setAddProviderId('');
      setAddModel('');
      showToast('绑定已保存', { variant: 'success' });
    } catch (err: unknown) {
      showToast(`保存失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  function getProviderName(pcId: string): string {
    return providers.find((p) => p.id === pcId)?.displayName ?? pcId;
  }

  // When opening the add form, default to first available provider + suggest its first model
  function openAddForm(): void {
    const firstProvider = providers[0];
    setAddProviderId(firstProvider?.id ?? '');
    setAddModel(firstModelSuggestion(firstProvider?.id ?? ''));
    setShowAdd(true);
  }

  function firstModelSuggestion(providerId: string): string {
    const p = allProviders.find((x) => x.id === providerId);
    const models = p?.definition?.defaultModels?.[requiredCap as Capability];
    return Array.isArray(models) ? (models[0] ?? '') : '';
  }

  return (
    <div className="flex gap-6 h-full">
      {/* Left: module list */}
      <div className="w-44 flex-shrink-0 flex flex-col gap-0.5 overflow-y-auto">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={`px-3 py-1.5 rounded-lg text-sm text-left transition-colors ${
              activeModule === m.id
                ? 'bg-pink-400/15 text-pink-300'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
            onClick={() => setActiveModule(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Right: bindings for selected module */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">
            {MODULES.find((m) => m.id === activeModule)?.label} 绑定
          </h2>
          {!showAdd && (
            <button
              className="px-3 py-1.5 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors"
              onClick={openAddForm}
            >添加绑定</button>
          )}
        </div>

        {loading ? (
          <div className="text-gray-500 text-sm">加载中…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {bindings.map((b, i) => (
              <div key={`${b.providerConfigId}-${b.model}-${i}`}
                className="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-3 border border-gray-700"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">{getProviderName(b.providerConfigId)}</span>
                  <span className="text-gray-600">/</span>
                  <span className="font-mono text-pink-300">{b.model}</span>
                  {i === 0 && <span className="text-xs text-gray-600 ml-2">默认</span>}
                </div>
                <button
                  className="px-2 py-1 rounded-lg text-xs bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  onClick={() => handleDelete(b.providerConfigId, b.model)}
                >删除</button>
              </div>
            ))}

            {bindings.length === 0 && !showAdd && (
              <div className="text-gray-500 text-sm">
                暂无绑定。先在"服务来源"配置 provider，再点右上角"添加绑定"。
              </div>
            )}

            {/* Inline add-binding form */}
            {showAdd && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 flex flex-col gap-3">
                <p className="text-sm text-gray-300 font-medium">新增绑定</p>

                {providers.length === 0 ? (
                  <p className="text-sm text-yellow-400">尚无已配置的 Provider，请先到"服务来源"新增。</p>
                ) : (
                  <>
                    <select
                      className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
                      value={addProviderId}
                      onChange={(e) => {
                        setAddProviderId(e.target.value);
                        setAddModel(firstModelSuggestion(e.target.value));
                      }}
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.displayName}</option>
                      ))}
                    </select>

                    {(() => {
                      const provider = allProviders.find((p) => p.id === addProviderId);
                      const suggestions: string[] = (provider?.definition?.defaultModels?.[requiredCap as Capability] as string[]) ?? [];
                      return (
                        <>
                          {suggestions.length > 0 && (
                            <select
                              className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
                              value={addModelCustom ? '__custom__' : addModel}
                              onChange={(e) => {
                                if (e.target.value === '__custom__') {
                                  setAddModelCustom(true);
                                  setAddModel('');
                                } else {
                                  setAddModelCustom(false);
                                  setAddModel(e.target.value);
                                }
                              }}
                            >
                              {suggestions.map((m: string) => <option key={m} value={m}>{m}</option>)}
                              <option value="__custom__">自定义模型…</option>
                            </select>
                          )}
                          {(suggestions.length === 0 || addModelCustom) && (
                            <input
                              className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
                              placeholder="输入自定义模型名称"
                              value={addModel}
                              onChange={(e) => setAddModel(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
                            />
                          )}
                        </>
                      );
                    })()}
                  </>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={saving || providers.length === 0}
                    className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors disabled:opacity-50"
                    onClick={() => void handleAdd()}
                  >{saving ? '保存中…' : '保存'}</button>
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl text-gray-400 text-sm hover:text-gray-200"
                    onClick={() => setShowAdd(false)}
                  >取消</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
