// 只显示已启用模型和该模型允许的推理强度; 模型目录由 ChatInput 读取一次并同时用于发送校验.
import type { JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { ReasoningEffort } from '@ema-agent/session';
import { findAvailableModel, type AvailableModel } from '../../api/providers.js';

export type ModelCatalog =
  | { readonly status: 'loading'; readonly models: AvailableModel[] }
  | { readonly status: 'error'; readonly models: AvailableModel[] }
  | { readonly status: 'ready'; readonly models: AvailableModel[] };

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: '无',
  low: '轻度',
  medium: '中',
  high: '高',
  max: '极高',
};

export function ModelPicker({ catalog, providerId, modelId, reasoningEffort, onModelChange, onEffortChange }: {
  catalog: ModelCatalog;
  providerId?: string | null;
  modelId?: string | null;
  reasoningEffort: ReasoningEffort;
  onModelChange(model: AvailableModel): void;
  onEffortChange(effort: ReasoningEffort): void;
}): JSX.Element {
  const selected = findAvailableModel(catalog.models, providerId, modelId);
  let label: string;
  if (catalog.status === 'loading') {
    label = '模型加载中';
  } else if (catalog.status === 'error') {
    label = '模型加载失败';
  } else if (selected) {
    label = `${selected.providerId} · ${selected.name ?? selected.modelId}`;
  } else if (providerId && modelId) {
    label = `${providerId} · ${modelId} (不可用)`;
  } else if (catalog.models.length === 0) {
    label = '请先配置并启用 LLM 模型';
  } else {
    label = '选择模型';
  }
  const canOpen = catalog.status === 'ready' && catalog.models.length > 0;
  const supportsReasoning = selected?.capability === 'llm' && selected.reasoning === true;

  // 只有菜单打开后才创建模型项. 每项用 providerId + modelId 作为稳定身份.
  const items = (): MenuItem[] => {
    const groups = new Map<string, AvailableModel[]>();
    for (const model of catalog.models) {
      const group = groups.get(model.providerId) ?? [];
      group.push(model);
      groups.set(model.providerId, group);
    }
    const modelItems: MenuItem[] = [];
    for (const [groupProviderId, models] of groups) {
      if (modelItems.length > 0) modelItems.push({ kind: 'separator' });
      modelItems.push({
        kind: 'item',
        id: `provider:${groupProviderId}`,
        label: groupProviderId,
        icon: 'i-lucide:server',
        disabled: true,
        onSelect: () => {},
      });
      for (const model of models) {
        modelItems.push({
          kind: 'item',
          id: `model:${model.providerId}:${model.modelId}`,
          label: model.name ?? model.modelId,
          icon: providerId === model.providerId && modelId === model.modelId
            ? 'i-lucide:check' : 'i-lucide:box',
          onSelect: () => onModelChange(model),
        });
      }
    }
    return [
      { kind: 'submenu', id: 'models', label: '模型', icon: 'i-lucide:box', items: modelItems },
      {
        kind: 'submenu',
        id: 'reasoning',
        label: supportsReasoning ? '推理强度' : '推理强度 (模型不支持)',
        icon: 'i-lucide:brain',
        items: (['off', 'low', 'medium', 'high', 'max'] as const).map(effort => ({
          kind: 'item',
          id: `effort:${effort}`,
          label: EFFORT_LABELS[effort],
          icon: reasoningEffort === effort ? 'i-lucide:check' : 'i-lucide:circle',
          disabled: !supportsReasoning,
          onSelect: () => onEffortChange(effort),
        })),
      },
    ];
  };

  return (
    <DropdownMenu
      side="top"
      align="end"
      widthClass="min-w-52"
      items={items}
      trigger={(
        <Button variant="ghost" className="ema-chat-btn min-w-0" title={label} disabled={!canOpen}>
          <span className="max-w-44 truncate">{label}</span>
          {selected && (
            <span className="text-[var(--ema-text-tertiary)]">
              {supportsReasoning ? EFFORT_LABELS[reasoningEffort] : '无'}
            </span>
          )}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}
