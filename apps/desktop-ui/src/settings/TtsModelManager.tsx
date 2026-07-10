import { useState, useEffect, useCallback, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, IconButton, Input, Spinner } from '@ema-agent/ui';
import { providersApi, type AvailableSimpleModelWire } from '../api/providers.js';
import { showToast } from '../lib/toast.js';
import { ModelToggleCard } from './ModelToggleCard.js';

const DEFAULT_TEST_TEXT = '你好，我是艾玛，很高兴认识你。';

export function TtsModelManager({ providerId, iconKey }: { providerId: string; iconKey?: string }): JSX.Element {
  const [models, setModels]     = useState<AvailableSimpleModelWire[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [testing, setTesting]   = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await providersApi.listTtsModels(providerId);
      setModels(res.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function enable(model: string): Promise<void> {
    try {
      await providersApi.enableTtsModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: true } : m)));
    } catch (err) {
      showToast(`启用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function confirmDisable(): Promise<void> {
    if (!confirmModel) return;
    const model = confirmModel;
    setConfirmModel(null);
    try {
      const res = await providersApi.disableTtsModel(providerId, model);
      setModels((ms) => ms.map((m) => (m.id === model ? { ...m, enabled: false } : m)));
      if (res.cascadedBindings > 0) {
        showToast(`已禁用，并解除了 ${res.cascadedBindings} 个绑定`, { variant: 'warning' });
      }
    } catch (err) {
      showToast(`禁用失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function handleTest(model: string): Promise<void> {
    setTesting(model);
    try {
      const blob = await providersApi.testTts(providerId, model, testText);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
      showToast('正在播放测试声音', { variant: 'success' });
    } catch (err) {
      showToast(`测试失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">TTS 模型</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {models.map((m) => (
            <ModelToggleCard
              key={m.id}
              id={m.id}
              enabled={m.enabled}
              onToggle={() => void (m.enabled ? setConfirmModel(m.id) : enable(m.id))}
              logo={iconKey}
              action={m.enabled ? (
                <IconButton
                  label="测试声音"
                  iconNode={
                    <span
                      className={testing === m.id
                        ? 'i-mdi:volume-high animate-pulse text-[var(--ema-primary)]'
                        : 'i-mdi:volume-high'}
                      aria-hidden
                    />
                  }
                  disabled={testing !== null}
                  variant="default"
                  size="sm"
                  type="button"
                  onClick={() => void handleTest(m.id)}
                />
              ) : undefined}
            />
          ))}
        </div>
      )}

      {/* 测试文本输入 */}
      <div className="flex gap-2 mt-1">
        <Input
          placeholder="测试文本"
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
        />
      </div>

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `禁用 "${confirmModel}"？使用它的 TTS 绑定也会一并解除。` : ''}
        confirmText="禁用"
        onConfirm={() => void confirmDisable()}
        onCancel={() => setConfirmModel(null)}
      />
    </div>
  );
}
