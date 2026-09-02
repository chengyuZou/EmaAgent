/** 服务来源总览：六个能力分区 × Provider 卡片（删除垃圾桶悬停浮现、配置状态点）+ 分区末 ⊕ 创建卡。 */
import React, { useEffect, useState } from 'react';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  MenuStatusItem,
  PROVIDER_ICON_ID_PATTERN,
  PROVIDER_ICONS,
  resolveProviderIconClass,
} from '@ema-agent/ui';
import { useProviderStore } from '../../stores/provider.js';
import { providersApi, type ProviderRecord, type ModelCapability } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { ProviderDetailPanel } from './ProviderDetailPanel.js';
import { ProviderCreatePanel } from './ProviderCreatePanel.js';
import { AddDashedCard } from './AddDashedCard.js';

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

const MODULE_LABELS: Record<string, string> = {
  'memory-llm': 'Memory',
  'kb-embed': '知识库嵌入',
  'kb-rerank': '知识库重排',
  title: '标题生成',
  'lightrag-embed': 'LightRAG 嵌入',
  'lightrag-llm': 'LightRAG LLM',
  tts: 'TTS',
  stt: 'STT',
  vision: 'Vision',
};

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

/** 已配置：bearer = 激活协议+key 齐；none = 该能力已有模型行（目录同步落库或手写，启停不论）。 */
function isConfigured(record: ProviderRecord, capability: ModelCapability): boolean {
  const row = capabilityOf(record, capability);
  if (row?.activeProtocol === undefined) return false;
  return record.authType === 'none'
    ? (row.modelCount ?? 0) > 0
    : record.keyValue !== undefined;
}

export function ProvidersTab(): JSX.Element {
  const providers = useProviderStore((s) => s.providers);
  // 首次提示判定：provider_models 空表 = 第一次使用（目录同步落库或手写都算"用过"）。
  const [hasAnyModels, setHasAnyModels] = useState<boolean | null>(null);
  useEffect(() => {
    providersApi.hasAnyModels()
      .then(({ hasAny }) => setHasAnyModels(hasAny))
      .catch(() => setHasAnyModels(null));
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<ModelCapability | null>(null);
  const [creatingFor, setCreatingFor] = useState<ModelCapability | null>(null);
  const [deleting, setDeleting] = useState<ProviderRecord | null>(null);

  const selected = providers.find((p) => p.id === selectedId);

  if (creatingFor) {
    return (
      <div key={`create-${creatingFor}`} className="ema-slide-right">
        <ProviderCreatePanel
          capability={creatingFor}
          label={SECTIONS.find((s) => s.key === creatingFor)?.label ?? creatingFor}
          onCancel={() => setCreatingFor(null)}
          onCreated={(providerId) => {
            const capability = creatingFor;
            setCreatingFor(null);
            setSelectedId(providerId);
            setSelectedCapability(capability);
          }}
        />
      </div>
    );
  }

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

  // 首次提示：provider_models 空表才算没用过（种子协议档不算）。
  const anyConfigured = hasAnyModels !== false;
  let cardIdx = 0;

  // 目前要删除的provider有哪些binding在用
  const deletingBindings = deleting
    ? Object.values(useProviderStore.getState().bindings)
        .filter((binding) => binding !== undefined && binding.providerId === deleting.id)
        .map((binding) => binding.module)
    : [];

  async function confirmDeleteProvider(): Promise<void> {
    const target = deleting;
    if (!target) return;
    setDeleting(null);
    try {
      // 先逐个解绑冲突模块，再删 Provider（后端 provider_in_use 守卫兜底）。
      for (const module of deletingBindings) {
        await useProviderStore.getState().deleteBinding(module as never);
      }
      await useProviderStore.getState().deleteProvider(target.id);
      showToast('已删除', { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    }
  }

  return (
    <div key="providers-grid" className="flex flex-col gap-8 pb-10 ema-fade-in">
      {!anyConfigured && (
        <Callout variant="info">
          <span className="font-medium">第一次使用？</span>
          <span className="ml-1">Ema 需要至少配置一个 LLM 服务来源并启用一个模型才能正常思考和运作。</span>
        </Callout>
      )}

      {SECTIONS.map((section) => {
        const sectionProviders = providers.filter((p) => capabilityOf(p, section.key) !== undefined);

        return (
          <section key={section.key}>
            <div className="flex items-center gap-3 mb-4 ema-stagger-in"
              style={{ '--stagger-i': cardIdx } as React.CSSProperties}>
              <span className={`${section.icon} text-4xl text-[var(--ema-text-tertiary)]`} aria-hidden />
              <h3 className="text-2xl font-semibold text-[var(--ema-text-primary)]">{section.label}</h3>
              <p className="text-sm text-[var(--ema-text-tertiary)]">{section.description}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sectionProviders.map((record) => {
                const staggerI = cardIdx++;
                return (
                  <div key={record.id} className="relative group/card ema-stagger-in"
                    style={{ '--stagger-i': staggerI } as React.CSSProperties}>
                    <MenuStatusItem
                      title={record.name}
                      description={capabilityHost(record, section.key)}
                      icon={resolveProviderIconClass(record.iconId)}
                      configured={isConfigured(record, section.key)}
                      onClick={() => { setSelectedId(record.id); setSelectedCapability(section.key); }}
                      className="after:hidden ema-card-decorate ema-card-decorate--plus"
                    />
                    <IconButton
                      label="删除服务来源"
                      icon="i-lucide:trash-2"
                      size="sm"
                      className="absolute right-2 top-2 z-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-[var(--ema-duration-base)]"
                      onClick={(e) => { e.stopPropagation(); setDeleting(record); }}
                    />
                  </div>
                );
              })}
              <AddDashedCard
                label={`添加${section.label}服务来源`}
                onClick={() => setCreatingFor(section.key)}
              />
            </div>
          </section>
        );
      })}

      <ConfirmDialog
        open={deleting !== null}
        message={deleting
          ? (deletingBindings.length > 0
            ? `"${deleting.name}" 正被 ${deletingBindings.map((m) => MODULE_LABELS[m] ?? m).join('、')} 绑定，删除将自动解除这些绑定，并清空它的模型与配置。`
            : `确定删除服务来源 "${deleting.name}"？它的模型与配置将一并清空。`)
          : ''}
        confirmText="删除"
        onConfirm={() => void confirmDeleteProvider()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ── Provider 配置页（L2）──────────────────────────────────────────────────────
function ProviderConfigPanel({
  provider, capability, onBack,
}: {
  provider:   ProviderRecord;
  capability: ModelCapability;
  onBack():   void;
}): JSX.Element {
  const health = provider.health.find((h) => h.capability === capability);
  const [editingIcon, setEditingIcon] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [customIcon, setCustomIcon] = useState('');

  const customIconTrimmed = customIcon.trim();
  const customIconValid = PROVIDER_ICON_ID_PATTERN.test(customIconTrimmed);

  /** 图标编辑：注册表内选 id，或 null 清除（前端不渲染图标）。 */
  async function pickIcon(iconId: string | null): Promise<void> {
    if (iconBusy) return;
    setIconBusy(true);
    try {
      await providersApi.patch(provider.id, { iconId });
      await useProviderStore.getState().refreshProviders();
      setEditingIcon(false);
      showToast('图标已更新', { variant: 'success' });
    } catch (err) {
      showToast(`更新失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setIconBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-10 pl-2">
      <div className="flex items-center gap-3">
        <IconButton
          label="返回服务来源"
          icon="i-solar:alt-arrow-left-line-duotone"
          size="sm"
          className="-ml-1.5"
          onClick={onBack}
        />
        <IconButton
          label="编辑图标"
          iconNode={<span className={`${resolveProviderIconClass(provider.iconId)} text-3xl`} aria-hidden />}
          size="md"
          onClick={() => setEditingIcon(true)}
        />
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

      <ProviderDetailPanel
        key={provider.id}
        provider={provider}
        capability={capability}
      />

      {/* 图标选择：注册表全量品牌图标 + 手写类名 + 无图标（清除）。 */}
      <Dialog
        open={editingIcon}
        onOpenChange={(open) => { if (!open) setEditingIcon(false); }}
        title="选择图标"
      >
        <div className="flex flex-col gap-4">
          {/* 手写 uno 图标类名（lobe-icons 全量可渲染；emoji/文本形态非法）。 */}
          <div className="flex items-end gap-2">
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="text-sm font-medium text-[var(--ema-text-secondary)]">手写图标类名</div>
              <Input
                placeholder="i-lobe-icons:qwen"
                value={customIcon}
                onChange={(e) => setCustomIcon(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="flex items-center gap-2 pb-0.5">
              {customIconValid && (
                <span className={`${customIconTrimmed} text-2xl`} aria-hidden />
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!customIconValid || iconBusy}
                loading={iconBusy}
                onClick={() => void pickIcon(customIconTrimmed)}
              >
                使用
              </Button>
            </div>
          </div>
          {customIconTrimmed && !customIconValid && (
            <p className="text-xs text-[var(--ema-danger-text)]">
              仅支持 uno 图标类名（如 i-lobe-icons:qwen），不支持 emoji 或普通文本
            </p>
          )}

          <div className="grid grid-cols-4 gap-2">
          {Object.entries(PROVIDER_ICONS).map(([id, iconClass]) => (
            <button
              key={id}
              type="button"
              disabled={iconBusy}
              onClick={() => void pickIcon(id)}
              className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 cursor-pointer
                          transition-all duration-[var(--ema-duration-base)]
                          ${provider.iconId === id
                            ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                            : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] hover:border-[var(--ema-primary)]/40 hover:bg-[var(--ema-surface-2)]'}`}
            >
              <span className={`${iconClass} text-2xl`} aria-hidden />
              <span className="text-[10px] text-[var(--ema-text-tertiary)] truncate max-w-full">{id}</span>
            </button>
          ))}
          <button
            type="button"
            disabled={iconBusy}
            onClick={() => void pickIcon(null)}
            className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 cursor-pointer
                        transition-all duration-[var(--ema-duration-base)]
                        ${provider.iconId === undefined
                          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                          : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] hover:border-[var(--ema-primary)]/40 hover:bg-[var(--ema-surface-2)]'}`}
          >
            <span className="i-solar:box-bold-duotone text-2xl text-[var(--ema-text-tertiary)]" aria-hidden />
            <span className="text-[10px] text-[var(--ema-text-tertiary)]">无图标</span>
          </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
