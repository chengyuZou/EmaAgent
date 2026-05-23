/**
 * BindingsTab — 13 BindingModule → list of (provider + model) bindings.
 */
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { modelBindingsApi, type BindingModule, type ResolvedModelBinding, type BindingUpsertInput } from '../api/model-bindings.js';
import { showToast } from '../lib/toast.js';

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
  { id: 'tts_chat',      label: 'TTS Chat' },
  { id: 'tts_narrative', label: 'TTS Narrative' },
  { id: 'tts_agent',     label: 'TTS Agent' },
  { id: 'stt',           label: 'STT' },
  { id: 'vision',        label: 'Vision' },
  { id: 'imagegen',      label: 'Image Gen' },
];

export function BindingsTab(): JSX.Element {
  const [activeModule, setActiveModule] = useState<BindingModule>('chat');
  const [bindings, setBindings] = useState<ResolvedModelBinding[]>([]);
  const [loading, setLoading] = useState(false);
  const providers = useSettingsStore((s) => s.providers);

  useEffect(() => {
    setLoading(true);
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

  function getProviderName(pcId: string): string {
    return providers.find((p) => p.id === pcId)?.displayName ?? pcId;
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
      <div className="flex-1">
        <h2 className="text-lg font-semibold mb-3">
          {MODULES.find((m) => m.id === activeModule)?.label} 绑定
        </h2>

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

            {bindings.length === 0 && (
              <div className="text-gray-500 text-sm">暂无绑定。去"服务来源"先配 provider，然后回来添加绑定。</div>
            )}

            {bindings.length > 0 && (
              <button
                className="mt-2 px-3 py-1.5 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors self-start"
              >添加绑定</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
