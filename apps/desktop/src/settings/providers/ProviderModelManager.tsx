// Provider 模型池：池内行 = SQL 事实（启用集合），卡片整卡点击 = 启停开关；
// llm/vision 提供目录刷新（models.dev 拉取并同步，新增默认禁用）；卡片按能力特化参数行与来源标记。
import { useState, useEffect, useCallback, useRef, type JSX, type ReactNode } from 'react';
import { Button, Callout, ConfirmDialog, Dialog, IconButton, Input, Spinner, Switch } from '@ema-agent/ui';
import { ServerApiError, serverClient } from '../../api/client.js';
import { charactersApi } from '../../api/characters.js';
import {
  providersApi,
  type ModelCapability,
  type ProviderModelInput,
  type ProviderModelRecord,
} from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';
import { useProviderStore } from '../../stores/provider.js';
import { AddDashedCard } from './AddDashedCard.js';

/** 模型卡：左上启停点（空心=禁用/绿点=启用）、整卡点击=启停、右上垃圾桶（角标不触发启停）。 */
function ModelCard({ title, hint, lines, chips, enabled, onToggle, logo, action }: {
  /** 显示名（name 回退 modelId）。 */
  title:    string;
  /** 悬停提示（模型 id；与显示名不同才给）。 */
  hint?:    string;
  /** 参数行（按能力特化）：如 "128K ctx" / "1024d"。 */
  lines:    string[];
  /** 能力标记：推理/图片/工具调用（llm/vision）。 */
  chips?:   ReactNode;
  enabled:  boolean;
  onToggle(): void;
  /** Provider 品牌图标类名，右缘淡显。 */
  logo?:    string;
  action?:  ReactNode;
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      title={hint}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      className={`group relative text-left rounded-lg border-2 border-solid px-3 py-2.5 min-w-0 cursor-pointer outline-none
                  overflow-hidden isolate
                  transition-all duration-[var(--ema-duration-base)] active:scale-[0.97]
                  before:content-empty before:absolute before:inset-0 before:z-0
                  before:w-1/4 before:h-full before:opacity-0
                  before:transition-all before:duration-[400ms] before:ease-in-out
                  before:[mask-image:linear-gradient(120deg,white_50%,transparent_75%)]
                  hover:before:opacity-100 hover:before:w-[85%]
                  hover:before:bg-gradient-to-r hover:before:from-[var(--ema-primary)]/30 hover:before:via-[var(--ema-primary)]/15 hover:before:to-transparent
                  ema-card-decorate ema-card-decorate--plus
                  ${enabled
                    ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                    : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-glass-weak hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]'
                  }`}
    >
      <span
        className={`absolute left-2 top-2 z-1 size-2.5 rounded-full transition-all duration-[var(--ema-duration-base)] ${
          enabled
            ? 'bg-[var(--ema-success)] ema-scale-in'
            : 'border-2 border-solid border-[var(--ema-border-strong)] bg-transparent'
        }`}
        aria-hidden
      />
      {logo && (
        <span
          className={`absolute right-1 top-1/2 z-1 -translate-y-1/2 size-6 opacity-40 group-hover:opacity-70 group-hover:scale-110 transition-all duration-[var(--ema-duration-base)] ${logo}`}
          aria-hidden
        />
      )}
      {action && (
        <span className="absolute right-1.5 top-1.5 z-2" onClick={(e) => e.stopPropagation()}>{action}</span>
      )}
      <div className="relative z-1 pl-4">
        <p className="text-[13px] font-mono font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] truncate pr-6 leading-tight">{title}</p>
        <div className="flex flex-col gap-0 mt-0.5 leading-snug">
          {lines.map((line) => (
            <p key={line} className="text-[11px] font-medium text-[var(--ema-text-tertiary)] truncate">{line}</p>
          ))}
        </div>
        {chips && (
          <div className="flex flex-wrap gap-1 mt-1.5">{chips}</div>
        )}
      </div>
    </div>
  );
}

const DEFAULT_TEST_TEXT = '你好，我是艾玛，很高兴认识你。';

const MODULE_LABELS: Record<string, string> = {
  'memory-llm': 'Memory',
  title: '标题生成',
  'lightrag-embed': 'LightRAG 嵌入',
  'lightrag-llm': 'LightRAG LLM',
  tts: 'TTS',
  stt: 'STT',
  vision: 'Vision',
};

// 各能力的页面文案与"添加模型"数字字段；Record 穷尽检查，capability 联合新增成员时编译报错。
const CAPABILITY_META: Record<ModelCapability, {
  title: string;
  hint?: string;
  addLabel: string;
  idPlaceholder: string;
  numericField?: { label: string; placeholder: string; invalid: string };
}> = {
  llm: {
    title: '模型池',
    hint: '点卡片启用/禁用；启用后才能在「模型绑定」里分配给各模块。',
    addLabel: '手写添加模型',
    idPlaceholder: '模型 ID，如 deepseek-chat',
    numericField: { label: '上下文窗口', placeholder: '窗口 token', invalid: '请填写上下文窗口(正整数 token 数)' },
  },
  embed: {
    title: '嵌入模型池',
    hint: '启用后可在「模型绑定」里分配给 embed 模块。',
    addLabel: '添加嵌入模型',
    idPlaceholder: '模型 ID，如 bge-m3',
    numericField: { label: '维度', placeholder: '维度', invalid: '维度需为正整数' },
  },
  rerank: {
    title: '重排序模型池',
    hint: '启用后可在「模型绑定」里分配给 rerank 模块。',
    addLabel: '添加重排序模型',
    idPlaceholder: '模型 ID，如 bge-reranker-v2-m3',
  },
  vision: {
    title: 'Vision 模型池',
    hint: '点卡片启用/禁用；启用后可在「模型绑定」里分配给 vision 模块。',
    addLabel: '手写添加 Vision 模型',
    idPlaceholder: '模型 ID，如 glm-4v',
    numericField: { label: '上下文窗口', placeholder: '窗口 token', invalid: '请填写上下文窗口(正整数 token 数)' },
  },
  tts: {
    title: 'TTS 模型池',
    addLabel: '添加 TTS 模型',
    idPlaceholder: '模型 ID，如 cosyvoice-v1',
  },
  stt: {
    title: 'STT 模型池',
    addLabel: '添加 STT 模型',
    idPlaceholder: '模型 ID，如 whisper-large-v3',
  },
};

/** 参数行按能力分流；来源标识为独立徽标（不进参数行）。 */
function linesOf(model: ProviderModelRecord): string[] {
  switch (model.capability) {
    case 'llm':
    case 'vision': {
      const parts = ['上下文 ' + formatContextWindow(model.contextWindow)];
      if (model.maxOutput !== null) parts.push(`最大输出 ${formatContextWindow(model.maxOutput)}`);
      return parts;
    }
    case 'embed':
      return [`dims ${model.dim}`];
    case 'rerank':
      return model.maxChunks != null ? [`maxChunks ${model.maxChunks}`] : [];
    default:
      return [];
  }
}

/** 能力徽标在前（推理/工具调用/图片），来源徽标（目录/手写）放最后。 */
function chipsOf(model: ProviderModelRecord): JSX.Element {
  const chips: JSX.Element[] = [];
  if (model.capability === 'llm' || model.capability === 'vision') {
    for (const [flag, text] of [
      [model.reasoning === true, '推理'],
      [model.toolCall === true, '工具调用'],
      [model.inputImage === true, '图片'],
    ] as const) {
      if (flag) {
        chips.push(
          <span key={text} className="text-[10px] font-medium text-[var(--ema-text-tertiary)] border border-[var(--ema-border)] rounded px-1 py-px">
            {text}
          </span>,
        );
      }
    }
  }
  chips.push(
    <span
      key="source"
      className={`text-[10px] font-medium rounded px-1 py-px border ${
        model.source === 'dev'
          ? 'text-[var(--ema-info-text)] border-[var(--ema-info)]/40 bg-[var(--ema-info-muted)]'
          : 'text-[var(--ema-primary-text)] border-[var(--ema-primary)]/40 bg-[var(--ema-primary-muted)]'
      }`}
    >
      {model.source === 'dev' ? '来源: ModelsDev' : '来源: 手写'}
    </span>,
  );
  return <>{chips}</>;
}

function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(0)}M`
    : `${(tokens / 1_000).toFixed(0)}K`;
}

/** 添加表单提交 → Route 输入联合；需要数字参数的 capability 缺数时返回 null（表单已拦截）。 */
function buildModelInput(input: {
  capability: ModelCapability;
  modelId: string;
  numeric: number | undefined;
  maxOutput: number | null;
  reasoning: boolean | null;
  toolCall: boolean | null;
  inputImage: boolean | null;
}): ProviderModelInput | null {
  switch (input.capability) {
    case 'llm':
    case 'vision':
      return input.numeric === undefined ? null : {
        capability: input.capability,
        modelId: input.modelId,
        contextWindow: input.numeric,
        maxOutput: input.maxOutput,
        reasoning: input.reasoning,
        toolCall: input.toolCall,
        inputImage: input.inputImage,
      };
    case 'embed':
      return input.numeric === undefined ? null : { capability: 'embed', modelId: input.modelId, dim: input.numeric };
    case 'rerank':
      return { capability: 'rerank', modelId: input.modelId };
    case 'tts':
      return { capability: 'tts', modelId: input.modelId };
    case 'stt':
      return { capability: 'stt', modelId: input.modelId };
  }
}

interface BindingConflict {
  module: string;
  modelId: string;
  capability: string;
}

interface PendingConflict {
  modelId: string;
  action: 'disable' | 'delete';
  conflicts: BindingConflict[];
}

function conflictsOf(err: unknown): BindingConflict[] | null {
  return err instanceof ServerApiError && err.code === 'model_in_use' && Array.isArray(err.conflicts)
    ? err.conflicts as BindingConflict[]
    : null;
}

export function ProviderModelManager({ providerId, capability, iconKey, reloadKey }: {
  providerId: string;
  capability: ModelCapability;
  iconKey?: string;
  /** Ping 成功/外部同步后 bump，触发模型池重载。 */
  reloadKey?: number;
}): JSX.Element {
  const meta = CAPABILITY_META[capability];
  const [models, setModels]   = useState<ProviderModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch]   = useState('');
  const [testText, setTestText] = useState(DEFAULT_TEST_TEXT);
  const [testing, setTesting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const canRefresh = capability === 'llm' || capability === 'vision';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await providersApi.listModels(providerId);
      setModels(rows.filter((m) => m.capability === capability));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [providerId, capability]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  /** 刷新 = 目录同步（llm/vision）或重读 SQL（其余能力）；200ms 防抖防连点。 */
  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (canRefresh) {
        const result = await providersApi.refreshModels(providerId, capability as 'llm' | 'vision');
        setModels([...result.models]);
        showToast('目录模型已同步', { variant: 'success' });
      } else {
        await load();
      }
    } catch (err) {
      showToast(`刷新失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      window.setTimeout(() => setRefreshing(false), 200);
    }
  }

  async function add(input: Parameters<typeof buildModelInput>[0]): Promise<void> {
    const body = buildModelInput(input);
    if (!body) return;
    try {
      await providersApi.saveModel(providerId, body);
      await load();
      setAdding(false);
      showToast('已添加', { variant: 'success' });
    } catch (err) {
      showToast(`添加失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  /** 卡片点击 = 拨开关；停用前先查本地绑定，被绑直接弹窗（确认才发请求），未被绑直接执行。 */
  async function toggle(model: ProviderModelRecord): Promise<void> {
    if (model.enabled) {
      const conflicts = localConflicts(model.modelId);
      if (conflicts.length > 0) {
        setPendingConflict({ modelId: model.modelId, action: 'disable', conflicts });
        return;
      }
      try {
        await applyDisable(model);
      } catch (err) {
        const conflicts = conflictsOf(err);
        if (conflicts) { setPendingConflict({ modelId: model.modelId, action: 'disable', conflicts }); return; }
        showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
      }
      return;
    }
    try {
      const updated = await providersApi.setModelEnabled(providerId, model.modelId, capability, true);
      setModels((ms) => ms.map((m) => (m.modelId === model.modelId ? updated : m)));
    } catch (err) {
      showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function applyDisable(model: ProviderModelRecord): Promise<void> {
    const updated = await providersApi.setModelEnabled(providerId, model.modelId, capability, false);
    setModels((ms) => ms.map((m) => (m.modelId === model.modelId ? updated : m)));
  }

  /** 垃圾桶点击：先查本地绑定——被绑直接弹"已绑定"框，无辜才弹普通移除框。 */
  function askRemove(model: ProviderModelRecord): void {
    const conflicts = localConflicts(model.modelId);
    if (conflicts.length > 0) {
      setPendingConflict({ modelId: model.modelId, action: 'delete', conflicts });
      return;
    }
    setConfirmModel(model.modelId);
  }

  async function confirmRemove(): Promise<void> {
    if (!confirmModel) return;
    const modelId = confirmModel;
    setConfirmModel(null);
    try {
      await providersApi.deleteModel(providerId, modelId, capability);
      setModels((ms) => ms.filter((m) => m.modelId !== modelId));
    } catch (err) {
      const conflicts = conflictsOf(err);
      if (conflicts) { setPendingConflict({ modelId, action: 'delete', conflicts }); return; }
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  /** 本地绑定预检：该 (provider, capability, modelId) 当前被哪些模块绑定（store 同源事实）。 */
  function localConflicts(modelId: string): BindingConflict[] {
    return Object.values(useProviderStore.getState().bindings)
      .filter((binding) => binding !== undefined
        && binding.providerId === providerId
        && binding.capability === capability
        && binding.modelId === modelId)
      .map((binding) => ({ module: binding.module, modelId: binding.modelId, capability: binding.capability }));
  }

  /** 冲突弹窗确认：逐个解绑冲突模块，然后重放原动作（禁用或删除）。 */
  async function resolveConflict(): Promise<void> {
    const pending = pendingConflict;
    if (!pending) return;
    setPendingConflict(null);
    try {
      for (const conflict of pending.conflicts) {
        await useProviderStore.getState().deleteBinding(conflict.module as never);
      }
      const model = models.find((m) => m.modelId === pending.modelId);
      if (pending.action === 'disable' && model) {
        await applyDisable(model);
      } else {
        await providersApi.deleteModel(providerId, pending.modelId, capability);
        setModels((ms) => ms.filter((m) => m.modelId !== pending.modelId));
      }
      showToast('已解绑并完成操作', { variant: 'success' });
    } catch (err) {
      showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  /** TTS 试听：音频字节流经 ttsPreview 取回本地播放。 */
  async function handleTest(modelId: string): Promise<void> {
    setTesting(modelId);
    try {
      const res = await providersApi.ttsPreview(providerId, modelId, testText);
      const url = URL.createObjectURL(await res.blob());
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

  // ── STT 试听：参考音频（当前角色主音频）播放 + 模型转写对照 ────────────────

  interface SttReference {
    characterId: string;
    characterName: string;
    sampleId: string;
    sampleName: string;
    promptText: string;
  }
  const [sttReference, setSttReference] = useState<SttReference | null>(null);
  const [sttTesting, setSttTesting] = useState<string | null>(null);
  const [sttResult, setSttResult] = useState<{ modelId: string; text: string; referenceText: string } | null>(null);
  const [playingReference, setPlayingReference] = useState(false);

  useEffect(() => {
    if (capability !== 'stt') return;
    void (async () => {
      try {
        const character = await charactersApi.current();
        const sample = character.voiceSamples.find((v) => v.enabled && v.isPrimary)
          ?? character.voiceSamples.find((v) => v.enabled);
        setSttReference(sample
          ? {
              characterId: character.id,
              characterName: character.name,
              sampleId: sample.id,
              sampleName: sample.name,
              promptText: sample.promptText,
            }
          : null);
      } catch {
        setSttReference(null);
      }
    })();
  }, [capability]);

  /** 模型 STT 试听：参考音频到该模型转写，结果与参考文本对照展示。 */
  async function handleSttTest(modelId: string): Promise<void> {
    setSttTesting(modelId);
    setSttResult(null);
    try {
      const result = await providersApi.sttPreview(providerId, modelId);
      setSttResult({ modelId, text: result.text, referenceText: result.referenceText });
    } catch (err) {
      showToast(`转写失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    } finally {
      setSttTesting(null);
    }
  }

  /** 参考音频播放控制：播放中按钮变终止（点击即停），结束/卸载自动停止。 */
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null);

  function stopReference(): void {
    referenceAudioRef.current?.pause();
    referenceAudioRef.current = null;
    setPlayingReference(false);
  }

  // 退出页面（组件卸载）时立刻停止播放。
  useEffect(() => () => {
    referenceAudioRef.current?.pause();
    referenceAudioRef.current = null;
  }, []);

  async function playReference(): Promise<void> {
    if (!sttReference) return;
    if (playingReference) { stopReference(); return; }
    setPlayingReference(true);
    try {
      const res = await serverClient.requestRaw(
        `/api/characters/${sttReference.characterId}/voice/${sttReference.sampleId}/file`,
      );
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      referenceAudioRef.current = audio;
      audio.addEventListener('ended', () => { URL.revokeObjectURL(url); stopReference(); }, { once: true });
      await audio.play();
    } catch (err) {
      stopReference();
      showToast(`播放失败: ${err instanceof Error ? err.message : '未知错误'}`, { variant: 'danger' });
    }
  }

  const filtered = search.trim()
    ? models.filter((m) => m.modelId.toLowerCase().includes(search.trim().toLowerCase()))
    : models;

  return (
    <div className="flex flex-col gap-3 mt-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">{meta.title}</h3>
          {meta.hint && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">{meta.hint}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing || loading} loading={refreshing}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {capability === 'llm' && (
        <div className="relative">
          <span className="i-mdi:magnify absolute left-3 top-1/2 -translate-y-1/2
                           text-[var(--ema-text-tertiary)] text-sm pointer-events-none" aria-hidden />
          <Input
            className="pl-8"
            placeholder="搜索模型…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && <div className="flex justify-center py-6"><Spinner size="md" /></div>}

      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filtered.map((m) => (
            <ModelCard
              key={m.modelId}
              title={m.name ?? m.modelId}
              hint={m.name !== undefined && m.name !== m.modelId ? m.modelId : undefined}
              lines={linesOf(m)}
              chips={chipsOf(m)}
              enabled={m.enabled}
              onToggle={() => void toggle(m)}
              logo={iconKey}
              action={(
                <span className="flex items-center gap-0.5">
                  {capability === 'tts' && (
                    <IconButton
                      label="测试声音"
                      iconNode={
                        <span
                          className={testing === m.modelId
                            ? 'i-mdi:volume-high animate-pulse text-[var(--ema-primary)]'
                            : 'i-mdi:volume-high'}
                          aria-hidden
                        />
                      }
                      disabled={testing !== null}
                      variant="default"
                      size="sm"
                      type="button"
                      onClick={() => void handleTest(m.modelId)}
                    />
                  )}
                  {capability === 'stt' && (
                    <IconButton
                      label="测试转写"
                      iconNode={
                        <span
                          className={sttTesting === m.modelId
                            ? 'i-lucide:audio-lines animate-pulse text-[var(--ema-primary)]'
                            : 'i-lucide:audio-lines'}
                          aria-hidden
                        />
                      }
                      disabled={sttTesting !== null}
                      variant="default"
                      size="sm"
                      type="button"
                      onClick={() => void handleSttTest(m.modelId)}
                    />
                  )}
                  <IconButton
                    label="移除模型"
                    icon="i-lucide:trash-2"
                    variant="default"
                    size="sm"
                    type="button"
                    onClick={() => askRemove(m)}
                  />
                </span>
              )}
            />
          ))}
          <AddDashedCard
            compact
            label="添加模型"
            onClick={() => setAdding(true)}
          />
        </div>
      )}

      {capability === 'tts' && (
        <div className="flex gap-2 mt-1">
          <Input
            placeholder="测试文本"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
          />
        </div>
      )}

      {/* STT 参考音频块：当前角色主参考音频（可播放/终止）+ 转写结果对照。 */}
      {capability === 'stt' && (
        <div className="flex flex-col gap-2 mt-4">
          <h3 className="text-base font-semibold text-[var(--ema-text-primary)]">参考音频</h3>
          <div className="rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-card-decorate ema-card-decorate--plus px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[var(--ema-text-secondary)]">
                  参考音频 · {sttReference ? `${sttReference.characterName} / ${sttReference.sampleName}` : '当前角色未配置'}
                </p>
                {sttReference && (
                  <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5 break-all">
                    参考文本：{sttReference.promptText}
                  </p>
                )}
              </div>
              {sttReference && (
                <IconButton
                  label={playingReference ? '终止播放' : '播放参考音频'}
                  iconNode={
                    <span
                      className={playingReference
                        ? 'i-lucide:square text-[var(--ema-danger)]'
                        : 'i-mdi:volume-high'}
                      aria-hidden
                    />
                  }
                  variant="default"
                  size="sm"
                  type="button"
                  onClick={() => void playReference()}
                />
              )}
            </div>
          </div>

          {sttResult && (
            <div className="rounded-lg border border-[var(--ema-info)]/40 bg-[var(--ema-info-muted)] px-3 py-2.5">
              <p className="text-xs font-medium text-[var(--ema-text-secondary)]">
                {sttResult.modelId} 转写结果
              </p>
              <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-1 break-all">
                参考文本：{sttResult.referenceText}
              </p>
              <p className={`text-[11px] mt-0.5 break-all ${
                sttResult.text.trim() === sttResult.referenceText.trim()
                  ? 'text-[var(--ema-success)]'
                  : 'text-[var(--ema-warning-text)]'
              }`}>
                转写文本：{sttResult.text}
                {sttResult.text.trim() === sttResult.referenceText.trim() ? '（一致）' : '（不一致）'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 手写添加：按能力特化字段（llm/vision 要窗口、embed 要维度、可选能力开关）。 */}
      <Dialog
        open={adding}
        onOpenChange={(open) => { if (!open) setAdding(false); }}
        title={meta.addLabel}
      >
        <ManualAddModelForm
          meta={meta}
          capability={capability}
          existing={models.map((m) => m.modelId)}
          onAdd={add}
        />
      </Dialog>

      <ConfirmDialog
        open={!!confirmModel}
        message={confirmModel ? `从模型池移除 "${confirmModel}"？` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirmModel(null)}
      />

      <ConfirmDialog
        open={!!pendingConflict}
        message={pendingConflict
          ? `该模型已被 ${pendingConflict.conflicts.map((c) => MODULE_LABELS[c.module] ?? c.module).join('、')} 绑定，${pendingConflict.action === 'disable' ? '禁用' : '删除'}将自动解除对这些模块的绑定。`
          : ''}
        confirmText={pendingConflict?.action === 'disable' ? '解绑并禁用' : '解绑并删除'}
        onConfirm={() => void resolveConflict()}
        onCancel={() => setPendingConflict(null)}
      />
    </div>
  );
}

// ── 手写添加（弹窗内表单） ────────────────────────────────────────────────────

function ManualAddModelForm({ meta, capability, existing, onAdd }: {
  meta: typeof CAPABILITY_META[ModelCapability];
  capability: ModelCapability;
  existing: string[];
  onAdd(input: Parameters<typeof buildModelInput>[0]): Promise<void>;
}): JSX.Element {
  const [query, setQuery]         = useState('');
  const [numeric, setNumeric]     = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [toolCall, setToolCall]   = useState(false);
  const [inputImage, setInputImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const withLlmParams = capability === 'llm' || capability === 'vision';

  async function add(): Promise<void> {
    const model = query.trim();
    if (!model) return;
    if (existing.includes(model)) { showToast('该模型已在列表中', { variant: 'warning' }); return; }
    let parsed: number | undefined;
    if (meta.numericField) {
      const n = parseInt(numeric, 10);
      if (!Number.isFinite(n) || n <= 0) {
        showToast(meta.numericField.invalid, { variant: 'danger' });
        return;
      }
      parsed = n;
    }
    const parsedMaxOutput = maxOutput.trim()
      ? parseInt(maxOutput, 10)
      : null;
    if (parsedMaxOutput !== null && (!Number.isFinite(parsedMaxOutput) || parsedMaxOutput <= 0)) {
      showToast('maxOutput 需为正整数', { variant: 'danger' });
      return;
    }
    setSubmitting(true);
    try {
      await onAdd({
        capability,
        modelId: model,
        numeric: parsed,
        maxOutput: parsedMaxOutput,
        reasoning: withLlmParams ? reasoning : null,
        toolCall: withLlmParams ? toolCall : null,
        inputImage: withLlmParams ? inputImage : null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-[var(--ema-text-secondary)]">模型 ID（必填）</div>
        <Input
          className="font-mono"
          placeholder={meta.idPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {meta.numericField && (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-[var(--ema-text-secondary)]">{meta.numericField.label}（必填）</div>
          <Input
            type="number"
            className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder={meta.numericField.placeholder}
            value={numeric}
            onChange={(e) => setNumeric(e.target.value)}
          />
        </div>
      )}
      {withLlmParams && (
        <>
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-[var(--ema-text-secondary)]">maxOutput（可空）</div>
            <Input
              type="number"
              className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              placeholder="最大输出 token 数"
              value={maxOutput}
              onChange={(e) => setMaxOutput(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-3">
            <Switch checked={reasoning} onCheckedChange={setReasoning} label="推理（支持 thinking）" showLabel />
            <Switch checked={toolCall} onCheckedChange={setToolCall} label="工具调用" showLabel />
            <Switch checked={inputImage} onCheckedChange={setInputImage} label="图片输入" showLabel />
          </div>
        </>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="primary" size="sm" loading={submitting} disabled={submitting || !query.trim()} onClick={() => void add()}>
          确认
        </Button>
      </div>
    </div>
  );
}
