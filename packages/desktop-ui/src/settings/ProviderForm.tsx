/** ProviderForm — add/edit a provider instance. */
import { useState, type FormEvent } from 'react';
import { useSettingsStore } from '../stores/settings-store.js';
import { providersApi, type ProviderConfigWire, type ProviderConfigInput } from '../api/providers.js';
import { showToast } from '../lib/toast.js';

export interface ProviderFormProps {
  definitionId: string;
  instance?:    ProviderConfigWire;
  onClose():    void;
}

export function ProviderForm({ definitionId, instance, onClose }: ProviderFormProps): JSX.Element {
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(instance?.baseUrl ?? '');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const input: ProviderConfigInput = {
        definitionId,
        displayName: displayName || undefined,
        apiKey:      apiKey || undefined,
        baseUrl:     baseUrl || null,
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
        <input
          className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          placeholder="API Key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <input
          className="bg-gray-900 border border-gray-600 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-pink-400/50"
          placeholder="Base URL（可选）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
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
