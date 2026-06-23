/**
 * ProvidersTab — AIRI-style provider grid grouped by capability.
 *
 * Level 1: capability sections (LLM / Embed / TTS / …), each a 2-column grid
 * of MenuStatusItem cards with the provider's brand icon and a configured
 * status dot. Level 2 (click a card): instance management for that provider
 * definition — list, add, edit, delete — with a back arrow.
 */
import React, { useState, useEffect } from 'react';
import { Button, Callout, IconButton, MenuStatusItem } from '@ema-agent/ui';
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
    description: '语音识别（语音转文字）' },
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
  // Which capability section the user entered from. ProviderForm renders ONLY
  // this capability's config — without it, a multi-capability provider (e.g.
  // SiliconFlow = llm+embed+tts+stt) showed the TTS block in every section.
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);

  useEffect(() => {
    void providersApi.listDefinitions().then(setDefinitions).catch(() => {});
  }, []);

  const selectedDefinition = definitions.find((d) => d.id === selectedDef);

  // ── Level 2: instance management ──────────────────────────────────────────
  if (selectedDef && selectedDefinition) {
    // One config per provider (no multi-instance — AIRI-style). The single
    // config row, or null when not yet configured.
    const config = providers.find((p) => p.definitionId === selectedDef) ?? null;
    return (
      <ProviderConfigPanel
        definition={selectedDefinition}
        capability={selectedCapability}
        config={config}
        onBack={() => { setSelectedDef(null); setSelectedCapability(null); }}
      />
    );
  }

  // ── Level 1: capability grid ──────────────────────────────────────────────
  const anyConfigured = providers.length > 0;

  // Global card index for stagger delay across all sections
  let cardIdx = 0;

  return (
    <div className="flex flex-col gap-8 pb-10">
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
            {/* Section header — subtle slide-down */}
            <div className="flex items-center gap-3 mb-4 ema-stagger-in"
              style={{ '--stagger-i': cardIdx } as React.CSSProperties}>
              <span className={`${section.icon} text-4xl text-neutral-500`} aria-hidden />
              <div>
                <p className="text-sm text-neutral-500">{section.description}</p>
                <h3 className="text-2xl font-normal text-neutral-100">{section.label}</h3>
              </div>
            </div>

            {/* Provider grid — each card staggers in */}
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
//
// One config per provider (AIRI-style — no multi-instance). The form is always
// open, editing the single config (or creating it on first save). When a config
// exists, a configured dot + latency + delete are shown in the header.

function ProviderConfigPanel({
  definition, capability, config, onBack,
}: {
  definition: ProviderDefinition;
  capability: Capability | null;
  config:     ProviderConfigWire | null;
  onBack():   void;
}): JSX.Element {
  function handleDelete(): void {
    if (!config) return;
    if (!confirm('确定删除这个服务来源？相关模型绑定也会失效。')) return;
    void useSettingsStore.getState().deleteProvider(config.id).then(() => {
      showToast('已删除', { variant: 'success' });
      onBack();
    }).catch((err: Error) => {
      showToast(`删除失败: ${err.message}`, { variant: 'danger' });
    });
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IconButton
            label="返回服务来源"
            icon="i-solar:alt-arrow-left-line-duotone"
            size="sm"
            className="-ml-1.5"
            onClick={onBack}
          />
          <span className={`${definition.iconKey ?? 'i-solar:box-bold-duotone'} text-3xl`} aria-hidden />
          <h2 className="text-xl font-medium text-neutral-100">{definition.name}</h2>
          {config && (
            <span className={`size-2 rounded-full ${config.health?.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
          )}
          {config?.health?.latencyMs != null && (
            <span className="text-xs text-neutral-500">{config.health.latencyMs}ms</span>
          )}
        </div>
        {config && (
          <Button variant="ghost" size="sm" className="text-neutral-500 hover:text-red-400" onClick={handleDelete}>
            删除
          </Button>
        )}
      </div>

      {/* Single config form — remounts (key) when the config is first created
          so the masked-key state and the model manager pick up the new id. */}
      <ProviderForm
        key={config?.id ?? 'new'}
        definitionId={definition.id}
        definition={definition}
        capability={capability ?? undefined}
        instance={config ?? undefined}
        onClose={onBack}
      />
    </div>
  );
}
