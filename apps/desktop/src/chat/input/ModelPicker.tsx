// 选择 Provider + LLM，并在同一菜单里冻结本 Turn 的推理强度。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { TurnModelSelection } from '@ema-agent/turn';
import { providersApi, findAvailableModel, type AvailableModel } from '../../api/providers.js';

type LlmModel = Extract<AvailableModel, { capability: 'llm' }>;

const EFFORT_LABELS: Record<TurnModelSelection['thinkingEffort'], string> = {
  low: '轻度',
  medium: '中',
  high: '高',
  max: '极高',
};

function isLlm(model: AvailableModel): model is LlmModel {
  return model.capability === 'llm';
}

export function ModelPicker({ selection, onChange, onClear }: {
  selection: TurnModelSelection | null;
  onChange(selection: TurnModelSelection): void;
  onClear(): void;
}): JSX.Element {
  // 可用目录直接用 API 拉（本地回环）；不进 Store，避免跨窗口漂移与人肉失效点。
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    providersApi.listAvailable('llm')
      .then(({ models }) => { setModels([...models]); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const grouped = useMemo(() => {
    const result = new Map<string, LlmModel[]>();
    for (const model of models.filter(isLlm)) {
      const group = result.get(model.providerId) ?? [];
      group.push(model);
      result.set(model.providerId, group);
    }
    return [...result.values()];
  }, [models]);
  const selectedModel = findAvailableModel(models, selection?.providerId, selection?.modelId);
  const label = selectedModel
    ? `${selectedModel.providerId} · ${selectedModel.name ?? selectedModel.modelId}`
    : !loaded ? '模型加载中' : '默认模型';

  const modelItems: MenuItem[] = grouped.flatMap((group, groupIndex) => [
    ...(groupIndex > 0 ? [{ kind: 'separator' as const }] : []),
    {
      kind: 'item' as const,
      label: group[0]?.providerId ?? 'Provider',
      icon: 'i-lucide:server',
      disabled: true,
      onSelect: () => {},
    },
    ...group.map(model => ({
      kind: 'item' as const,
      label: model.name ?? model.modelId,
      icon: selection?.providerId === model.providerId && selection.modelId === model.modelId
        ? 'i-lucide:check' : 'i-lucide:box',
      onSelect: () => onChange({
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingEnabled: model.reasoning === true && (selection?.thinkingEnabled ?? false),
        thinkingEffort: selection?.thinkingEffort ?? 'medium',
      }),
    })),
  ]);

  const reasoningAvailable = selection !== null
    && selectedModel?.capability === 'llm'
    && selectedModel.reasoning === true;
  const effortItems: MenuItem[] = [
    {
      kind: 'item', label: '无',
      icon: selection?.thinkingEnabled === false ? 'i-lucide:check' : 'i-lucide:circle',
      disabled: !reasoningAvailable,
      onSelect: () => selection && onChange({ ...selection, thinkingEnabled: false }),
    },
    ...(['low', 'medium', 'high', 'max'] as const).map(effort => ({
      kind: 'item' as const,
      label: EFFORT_LABELS[effort],
      icon: selection?.thinkingEnabled && selection.thinkingEffort === effort
        ? 'i-lucide:check' : 'i-lucide:circle',
      disabled: !reasoningAvailable,
      onSelect: () => selection && onChange({ ...selection, thinkingEnabled: true, thinkingEffort: effort }),
    })),
  ];

  const items: MenuItem[] = [
    { kind: 'submenu', label: '模型', icon: 'i-lucide:box', items: modelItems },
    {
      kind: 'submenu',
      label: '推理强度',
      icon: 'i-lucide:brain',
      items: effortItems,
    },
    ...(selection ? [
      { kind: 'separator' as const },
      { kind: 'item' as const, label: '恢复默认模型', icon: 'i-lucide:rotate-ccw', onSelect: onClear },
    ] : []),
  ];

  const reasoning = !selection?.thinkingEnabled ? '无' : EFFORT_LABELS[selection.thinkingEffort];
  return (
    <DropdownMenu side="top" align="end" widthClass="min-w-52" items={items} trigger={(
      <Button variant="ghost" className="min-w-0 gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ema-text-secondary)]" title={label}>
        <span className="i-lucide:box text-sm" aria-hidden />
        <span className="max-w-44 truncate">{label}</span>
        {selection && <span className="text-[var(--ema-text-tertiary)]">{reasoning}</span>}
        <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
      </Button>
    )} />
  );
}
