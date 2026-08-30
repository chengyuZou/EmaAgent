import React, { useState } from 'react';
import {
  Button,
  Callout,
  ConfirmDialog,
  IconButton,
  MenuStatusItem,
  resolveProviderIconClass,
} from '@ema-agent/ui';
import { useProviderStore } from '../../stores/provider.js';
import type { ProviderRecord, ModelCapability } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ProviderForm } from './ProviderForm.js';

// ── Capability sections ───────────────────────────────────────────────────────

const SECTIONS: ReadonlyArray<{ key: ModelCapability; label: string; icon: string; description: string }> = [
  { key: 'llm',      label: 'LLM',       icon: 'i-solar:chat-square-like-bold-duotone',
    description: '文本生成模型，如 DeepSeek、OpenAI、Ollama' },
  { key: 'embed',    label: 'Embed',     icon: 'i-solar:structure-bold-duotone',
    description: '向量化模型，记忆召回与知识检索使用' },
  { key: 'rerank',   label: 'Rerank',    icon: 'i-solar:sort-from-top-to-bottom-bold-duotone',
    description: '重排序模型，提升召回精度' },
  { key: 'tts',      label: 'TTS',       icon: 'i-solar:user-speak-rounded-bold-duotone',
    description: '语音合成，如 SiliconFlow CosyVoice、GPT-SoVITS' },
  { key: 'stt',      label: 'STT',       icon: 'i-solar:microphone-3-bold-duotone',
    description: '语音识别(语音转文字)' },
  { key: 'vision',   label: 'Vision',    icon: 'i-solar:eye-bold-duotone',
    description: '图像理解模型' },
];

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}

function capabilityOf(record: ProviderRecord, capability: ModelCapability) {
  return record.capabilities.find((c) => c.capability === capability);
}

function capabilityHost(record: ProviderRecord, capability: ModelCapability): string {
  const row = capabilityOf(record, capability);
  const active = row?.protocols.find((p) => p.protocol === row.activeProtocol);
  return hostOf((active ?? row?.protocols[0])?.baseUrl);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProvidersTab(): JSX.Element {
  const providers = useProviderStore((s) => s.providers);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<ModelCapability | null>(null);

  const selected = providers.find((p) => p.id === selectedId);

  if (selected && selectedCapability) {
    return (
      <div key={selected.id} className="ema-slide-right">
        <ProviderConfigPanel
          provider={selected}
          capability={selectedCapability}
          onBack={() => { setSelectedId(null); setSelectedCapability(null); }}
        />
      </div>
    );
  }

  const anyConfigured = providers.some((p) =>
    p.capabilities.some((c) => c.activeProtocol !== undefined));
  let cardIdx = 0;

  return (
    <div key="providers-grid" className="flex flex-col gap-8 pb-10 ema-fade-in">
      {!anyConfigured && (
        <Callout variant="info">
          <span className="font-medium">第一次使用？</span>
          <span className="ml-1">Ema 需要至少配置一个 LLM 服务来源才能正常思考和运作。</span>
        </Callout>
      )}

      {SECTIONS.map((section) => {
        const sectionProviders = providers.filter((p) => capabilityOf(p, section.key) !== undefined);
        if (sectionProviders.length === 0) return null;

        return (
          <section key={section.key}>
            <div className="flex items-center gap-3 mb-4 ema-stagger-in"
              style={{ '--stagger-i': cardIdx } as React.CSSProperties}>
              <span className={`${section.icon} text-4xl text-[var(--ema-text-tertiary)]`} aria-hidden />
              <div>
                <p className="text-sm text-[var(--ema-text-tertiary)]">{section.description}</p>
                <h3 className="text-2xl font-semibold text-[var(--ema-text-primary)]">{section.label}</h3>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sectionProviders.map((record) => {
                const staggerI = cardIdx++;
                const row = capabilityOf(record, section.key);
                return (
                  <MenuStatusItem
                    key={record.id}
                    title={record.name}
                    description={capabilityHost(record, section.key)}
                    icon={resolveProviderIconClass(record.iconId)}
                    configured={row?.activeProtocol !== undefined}
                    onClick={() => { setSelectedId(record.id); setSelectedCapability(section.key); }}
                    style={{ '--stagger-i': staggerI } as React.CSSProperties}
                    className="ema-stagger-in"
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Provider config panel (level 2) ──────────────────────────────────────────

function ProviderConfigPanel({
  provider, capability, onBack,
}: {
  provider:   ProviderRecord;
  capability: ModelCapability;
  onBack():   void;
}): JSX.Element {
  const [confirmAction, setConfirmAction] = useState<'delete' | 'discard' | null>(null);
  const [formDirty, setFormDirty] = useState(false);

  const health = provider.health.find((h) => h.capability === capability);

  function handleBack(): void {
    if (formDirty) {
      setConfirmAction('discard');
      return;
    }
    onBack();
  }

  function confirmDelete(): void {
    setConfirmAction(null);
    void useProviderStore.getState().deleteProvider(provider.id).then(() => {
      showToast('已删除', { variant: 'success' });
      onBack();
    }).catch((err: Error) => {
      showToast(`删除失败: ${err.message}`, { variant: 'danger' });
    });
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IconButton
            label="返回服务来源"
            icon="i-solar:alt-arrow-left-line-duotone"
            size="sm"
            className="-ml-1.5"
            onClick={handleBack}
          />
          <span className={`${resolveProviderIconClass(provider.iconId)} text-3xl`} aria-hidden />
          <h2 className="text-xl font-semibold text-[var(--ema-text-primary)]">{provider.name}</h2>
          {health && (
            <span className={`size-2 rounded-full ${
              health.status === 'ok'
                ? 'bg-[var(--ema-success)]'
                : 'bg-[var(--ema-danger)]'
            }`} />
          )}
          {health?.latencyMs != null && (
            <span className="text-xs text-[var(--ema-text-tertiary)]">{health.latencyMs}ms</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)]"
          onClick={() => setConfirmAction('delete')}
        >
          删除
        </Button>
      </div>

      <ProviderForm
        key={provider.id}
        provider={provider}
        capability={capability}
        onClose={handleBack}
        onDirtyChange={setFormDirty}
      />

      <ConfirmDialog
        open={confirmAction !== null}
        message={confirmAction === 'delete'
          ? '确定删除这个服务来源？相关模型绑定也会失效。'
          : '当前配置尚未保存，确定放弃这些更改？'}
        confirmText={confirmAction === 'delete' ? '删除' : '放弃更改'}
        onConfirm={confirmAction === 'delete' ? confirmDelete : onBack}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
