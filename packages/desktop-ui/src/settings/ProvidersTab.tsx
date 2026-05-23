/**
 * ProvidersTab — list provider definitions + add/edit instances.
 */
import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { providersApi, type ProviderDefinitionWire, type ProviderConfigWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';
import { ProviderCard } from './ProviderCard.js';
import { ProviderForm } from './ProviderForm.js';

export function ProvidersTab(): JSX.Element {
  const providers = useSettingsStore((s) => s.providers);
  const [definitions, setDefinitions] = useState<ProviderDefinitionWire[]>([]);
  const [selectedDef, setSelectedDef] = useState<string | null>(null);
  const [editingInstance, setEditingInstance] = useState<ProviderConfigWire | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    void providersApi.listDefinitions().then(setDefinitions).catch(() => {});
  }, []);

  const instancesForDef = providers.filter((p) => p.definitionId === selectedDef);
  const selectedDefinition = definitions.find((d) => d.id === selectedDef);

  function handleDeleteProvider(id: string): void {
    if (!confirm('确定删除这个服务来源？相关模型绑定也会失效。')) return;
    void useSettingsStore.getState().deleteProvider(id).then(() => {
      showToast('已删除', { variant: 'success' });
    }).catch((err: Error) => {
      showToast(`删除失败: ${err.message}`, { variant: 'danger' });
    });
  }

  return (
    <div className="flex gap-6 h-full">
      {/* Left: definition cards */}
      <div className="w-80 flex-shrink-0 flex flex-col gap-2 overflow-y-auto">
        {definitions.map((def) => {
          const instances = providers.filter((p) => p.definitionId === def.id);
          const healthy = instances.filter((p) => p.health?.status === 'ok').length;
          return (
            <ProviderCard
              key={def.id}
              def={def}
              instanceCount={instances.length}
              healthyCount={healthy}
              selected={selectedDef === def.id}
              onClick={() => { setSelectedDef(def.id); setEditingInstance(null); }}
            />
          );
        })}
      </div>

      {/* Right: instances of selected definition */}
      <div className="flex-1">
        {!selectedDef || !selectedDefinition ? (
          <div className="text-gray-500 text-center mt-20">选择一个服务来源查看已配置的实例</div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{selectedDefinition.name}</h2>
              <button
                className="px-3 py-1.5 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors"
                onClick={() => { setEditingInstance(null); setShowForm(true); }}
              >新增实例</button>
            </div>

            {instancesForDef.length === 0 && !showForm && (
              <div className="text-gray-500 text-sm">暂无实例，点击"新增实例"添加</div>
            )}

            <div className="flex flex-col gap-2">
              {instancesForDef.map((inst) => (
                <div
                  key={inst.id}
                  className="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-3 border border-gray-700"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${inst.health?.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                    <span className="text-sm font-medium">{inst.displayName}</span>
                    {inst.health?.latencyMs && (
                      <span className="text-xs text-gray-500">{inst.health.latencyMs}ms</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-2 py-1 rounded-lg text-xs bg-gray-700 text-gray-300 hover:bg-gray-600"
                      onClick={() => { setEditingInstance(inst); setShowForm(true); }}
                    >编辑</button>
                    <button
                      className="px-2 py-1 rounded-lg text-xs bg-red-500/20 text-red-300 hover:bg-red-500/30"
                      onClick={() => handleDeleteProvider(inst.id)}
                    >删除</button>
                  </div>
                </div>
              ))}
            </div>

            {showForm && (
              <div className="mt-4">
                <ProviderForm
                  definitionId={selectedDef}
                  instance={editingInstance ?? undefined}
                  onClose={() => { setShowForm(false); setEditingInstance(null); }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
