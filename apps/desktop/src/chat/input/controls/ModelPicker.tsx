import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { ReasoningEffort } from '@ema-agent/session';
import { findAvailableModel, providersApi, type AvailableModel } from '../../../api/providers.js';

import type { SessionListItem } from '../../../api/sessions.js';
import type { ChatDraft } from '../../../stores/chatDraft.js';
import { useSessionStore } from '../../../stores/session.js';
import { useTurnStore } from '../../../stores/turn.js';
import { showToast } from '../../../lib/toast.js';
import { subscribeSystemEvent } from '../../../lib/system-event-dispatcher.js';

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

export function useInputModel(
  viewedId: string | null,
  viewedSession: SessionListItem | undefined,
  draft: ChatDraft,
  patchCurrentDraft: (patch: Partial<ChatDraft>) => void,
) {
  const [catalog, setCatalog] = useState<ModelCatalog>({ status: 'loading', models: [] });
  const [modelEdit, setModelEdit] = useState<{
    sessionId: string;
    providerId: string;
    modelId: string;
    reasoningEffort: ReasoningEffort;
    status: 'saving' | 'error';
  } | null>(null);
  const modelEditVersion = useRef(0);
  const reasoningResetKey = useRef<string | null>(null);
  // 新对话从草稿取选择; 已有对话从 Session 取已保存事实. 保存期间显示用户刚选的值, 失败时保留它但禁止发送.
  const shownModelEdit = modelEdit?.sessionId === viewedId ? modelEdit : null;
  const selectedProviderId = viewedId
    ? shownModelEdit?.providerId ?? viewedSession?.providerId
    : draft.providerId;
  const selectedModelId = viewedId
    ? shownModelEdit?.modelId ?? viewedSession?.modelId
    : draft.modelId;
  const selectedReasoningEffort = viewedId
    ? shownModelEdit?.reasoningEffort ?? viewedSession?.reasoningEffort ?? 'off'
    : draft.reasoningEffort;
  const selectedModel = findAvailableModel(catalog.models, selectedProviderId, selectedModelId);

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const loadModels = (): void => {
      const current = ++request;
      setCatalog({ status: 'loading', models: [] });
      void providersApi.listAvailable('llm').then(({ models }) => {
        if (active && current === request) setCatalog({ status: 'ready', models: [...models] });
      }).catch(() => {
        if (active && current === request) setCatalog({ status: 'error', models: [] });
      });
    };
    loadModels();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type !== 'provider_config_changed' && event.type !== 'provider_models_changed') return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadModels, 150);
    });
    return () => {
      active = false;
      request += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, []);

  // Settings 窗口可能把当前模型改为不支持推理. 目录刷新后同样要把 Session 的旧强度关掉.
  useEffect(() => {
    if (!viewedId || !viewedSession || !selectedModel || selectedModel.capability !== 'llm'
      || selectedModel.reasoning === true || viewedSession.reasoningEffort === 'off') {
      // 同一模型以后仍可能在 Settings 再次关闭推理能力, 不能永久记住上次重置.
      reasoningResetKey.current = null;
      return;
    }
    if (shownModelEdit) return;
    const key = `${viewedId}:${viewedSession.providerId}:${viewedSession.modelId}`;
    if (reasoningResetKey.current === key) return;
    reasoningResetKey.current = key;
    void saveModelChoice(viewedId, viewedSession.providerId!, viewedSession.modelId!, 'off', false);
  }, [catalog, viewedId, viewedSession, selectedModel, shownModelEdit]);

  async function saveModelChoice(
    sessionId: string,
    providerId: string,
    modelId: string,
    reasoningEffort: ReasoningEffort,
    changeModel: boolean,
  ): Promise<void> {
    const version = ++modelEditVersion.current;
    setModelEdit({ sessionId, providerId, modelId, reasoningEffort, status: 'saving' });
    try {
      if (changeModel) {
        await useSessionStore.getState().setModel(sessionId, providerId, modelId, reasoningEffort);
        useTurnStore.getState().invalidateContextUsage(sessionId);
      } else {
        await useSessionStore.getState().setReasoningEffort(sessionId, reasoningEffort);
      }
      if (modelEditVersion.current === version) setModelEdit(null);
    } catch (error) {
      if (modelEditVersion.current === version) {
        setModelEdit({ sessionId, providerId, modelId, reasoningEffort, status: 'error' });
      }
      showToast(error instanceof Error ? `保存模型设置失败: ${error.message}` : '保存模型设置失败', { variant: 'danger' });
    }
  }

  function chooseModel(model: AvailableModel): void {
    const effort = model.capability === 'llm' && model.reasoning === true
      ? selectedReasoningEffort : 'off';
    if (viewedId) {
      void saveModelChoice(viewedId, model.providerId, model.modelId, effort, true);
    } else {
      patchCurrentDraft({ providerId: model.providerId, modelId: model.modelId, reasoningEffort: effort });
    }
  }

  function chooseReasoningEffort(reasoningEffort: ReasoningEffort): void {
    if (!selectedProviderId || !selectedModelId) return;
    if (viewedId) {
      void saveModelChoice(viewedId, selectedProviderId, selectedModelId, reasoningEffort, false);
    } else {
      patchCurrentDraft({ reasoningEffort });
    }
  }

  return {
    catalog,
    shownModelEdit,
    selectedProviderId,
    selectedModelId,
    selectedReasoningEffort,
    selectedModel,
    chooseModel,
    chooseReasoningEffort,
  };
}

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
