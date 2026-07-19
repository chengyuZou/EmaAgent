/**
 * ProvidersTab — AIRI-style provider grid grouped by capability.
 */
import React, { useState, useEffect } from 'react';
import { Button, Callout, ConfirmDialog, IconButton, MenuStatusItem } from '@ema-agent/ui';
import { useSettingsStore } from '../stores/settings-store.js';
import { providersApi, type ProviderDefinition, type ProviderConfigWire } from '../api/providers.js';
import type { Capability } from '@ema-agent/contracts';
import { showToast } from '../lib/toast.js';
import { ProviderForm } from './ProviderForm.js';

// ── Capability sections ───────────────────────────────────────────────────────

const SECTIONS = [
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
  { key: 'imagegen', label: 'Image Gen', icon: 'i-solar:gallery-bold-duotone',
    description: '图像生成模型' },
] as const;

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ProvidersTab(): JSX.Element {
  const providers = useSettingsStore((s) => s.providers);
  const [definitions, setDefinitions] = useState<ProviderDefinition[]>([]);
  const [selectedDef, setSelectedDef] = useState<string | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);

  useEffect(() => {
    void providersApi.listDefinitions().then(setDefinitions).catch(() => {});
  }, []);

  const selectedDefinition = definitions.find((d) => d.id === selectedDef);

  if (selectedDef && selectedDefinition) {
    const config = providers.find((p) => p.definitionId === selectedDef) ?? null;
    return (
      <div key={selectedDef} className="ema-slide-right">
        <ProviderConfigPanel
          definition={selectedDefinition}
          capability={selectedCapability}
          config={config}
          onBack={() => { setSelectedDef(null); setSelectedCapability(null); }}
        />
      </div>
    );
  }

  const anyConfigured = providers.length > 0;
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
        const sectionDefs = definitions.filter((d) =>
          (d.capabilities as readonly string[]).includes(section.key));
        if (sectionDefs.length === 0) return null;

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
              {sectionDefs.map((def) => {
                const instances = providers.filter((p) => p.definitionId === def.id);
                const staggerI = cardIdx++;
                return (
                  <MenuStatusItem
                    key={def.id}
                    title={def.name}
                    description={hostOf(def.defaultBaseUrl)}
                    icon={def.iconKey ?? 'i-solar:box-bold-duotone'}
                    configured={instances.length > 0}
                    onClick={() => { setSelectedDef(def.id); setSelectedCapability(section.key as Capability); }}
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
  definition, capability, config, onBack,
}: {
  definition: ProviderDefinition;
  capability: Capability | null;
  config:     ProviderConfigWire | null;
  onBack():   void;
}): JSX.Element {
  const [confirmAction, setConfirmAction] = useState<'delete' | 'discard' | null>(null);
  const [formDirty, setFormDirty] = useState(false);

  function handleDelete(): void {
    if (!config) return;
    setConfirmAction('delete');
  }

  function handleBack(): void {
    if (formDirty) {
      setConfirmAction('discard');
      return;
    }
    onBack();
  }

  function confirmDelete(): void {
    if (!config) return;
    setConfirmAction(null);
    void useSettingsStore.getState().deleteProvider(config.id).then(() => {
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
          <span className={`${definition.iconKey ?? 'i-solar:box-bold-duotone'} text-3xl`} aria-hidden />
          <h2 className="text-xl font-semibold text-[var(--ema-text-primary)]">{definition.name}</h2>
          {config && (
            <span className={`size-2 rounded-full ${
              config.health?.status === 'ok'
                ? 'bg-[var(--ema-success)]'
                : 'bg-[var(--ema-danger)]'
            }`} />
          )}
          {config?.health?.latencyMs != null && (
            <span className="text-xs text-[var(--ema-text-tertiary)]">{config.health.latencyMs}ms</span>
          )}
        </div>
        {config && (
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)]"
            onClick={handleDelete}
          >
            删除
          </Button>
        )}
      </div>

      <ProviderForm
        key={config?.id ?? 'new'}
        definitionId={definition.id}
        definition={definition}
        capability={capability ?? undefined}
        instance={config ?? undefined}
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
