// Live2D Tab(3+4 同页,参 Airi 桌面版):上资源列表,下选中项配置,点列表自动切换。
// 右上[导入]下拉=ZIP包/文件夹;语义词这批只读不可增删改(仅允许换原生目标+保存);
// [测试]置灰挂联调批(试播要走主窗口唯一 Canvas)。
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  Badge, Button, DropdownMenu, IconButton, ScrollArea, Select, Slider, Spinner,
  type MenuItem,
} from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import {
  charactersApi,
  type Character,
  type Live2dConfiguration,
} from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { renderLive2dPreview } from '../../lib/live2dPreview.js';
import { ServerImage } from '../../lib/ServerImage.js';
import { fetchServerObjectUrl } from '../../lib/serverFileUrl.js';
import { showToast } from '../../lib/toast.js';

type Live2dModel = Character['live2dModels'][number];

export function Live2dTab({ character }: { character: Character }): JSX.Element {
  const models = character.live2dModels;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = models.find(m => m.name === selectedName)
    ?? models.find(m => m.isPrimary)
    ?? models[0];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">Live2D</h3>
        <ImportMenu character={character} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-5 pb-5">
          {models.length === 0 && (
            <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">
              还没有 Live2D 模型,点右上角导入
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {models.map((model, index) => (
              <ModelCard
                key={model.name}
                character={character}
                model={model}
                index={index}
                selected={selected?.name === model.name}
                onSelect={() => setSelectedName(model.name)}
              />
            ))}
          </div>
          {selected && (
            <ModelConfig
              key={`${character.name}/${selected.name}`}
              character={character}
              model={selected}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── 资源卡 ────────────────────────────────────────────────────────────────────

function ModelCard({
  character, model, index, selected, onSelect,
}: {
  character: Character;
  model: Live2dModel;
  index: number;
  selected: boolean;
  onSelect(): void;
}): JSX.Element {
  const store = useCharacterStore();

  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: '打开文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void charactersApi.live2dLocation(character.name, model.name)
          .then(({ path }) => charactersApi.openInFolder(path))
          .catch(() => showToast('打开文件夹失败', { variant: 'danger' }));
      },
    },
    {
      kind: 'item',
      label: '导出',
      icon: 'i-solar:download-minimalistic-bold-duotone',
      onSelect: () => {
        void (async () => {
          const destination = await tauriBridge.openFileDialog({ directory: true });
          if (!destination) return;
          try {
            await charactersApi.exportLive2d(character.name, model.name, destination);
            showToast('已导出', { variant: 'success' });
          } catch (error) {
            showToast(error instanceof Error ? error.message : '导出失败', { variant: 'danger' });
          }
        })();
      },
    },
    {
      kind: 'item',
      label: '永久删除',
      icon: 'i-solar:trash-bin-trash-bold-duotone',
      onSelect: () => {
        void store.deleteLive2d(character.name, model.name)
          .then(() => showToast('已删除模型', { variant: 'success' }))
          .catch(error => showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' }));
      },
    },
  ];

  return (
    <div
      className={`ema-stagger-in group relative cursor-pointer overflow-hidden rounded-xl border
        transition-all duration-[var(--ema-duration-base)] hover:-translate-y-0.5
        hover:shadow-[var(--ema-shadow-soft)]
        ${selected
          ? 'border-[var(--ema-primary)] shadow-[var(--ema-shadow-1)]'
          : 'border-[var(--ema-border)] bg-[var(--ema-surface-2)]'}`}
      style={{ '--stagger-i': index } as React.CSSProperties}
      onClick={onSelect}
    >
      <div className="absolute left-2 top-2 z-10" onClick={event => event.stopPropagation()}>
        <button
          type="button"
          className={`h-4 w-4 rounded-full border-2 transition-all
            ${model.isPrimary
              ? 'border-[var(--ema-success)] bg-[var(--ema-success)]'
              : 'border-[var(--ema-text-tertiary)] hover:border-[var(--ema-text-secondary)]'}`}
          title={model.isPrimary ? '主要模型' : '设为主要模型'}
          onClick={() => {
            if (!model.isPrimary) {
              void store.setPrimaryLive2d(character.name, model.name)
                .catch(error => showToast(error instanceof Error ? error.message : '设置失败', { variant: 'danger' }));
            }
          }}
        />
      </div>
      <div className="absolute right-2 top-2 z-10" onClick={event => event.stopPropagation()}>
        <DropdownMenu
          side="bottom"
          align="end"
          items={menuItems}
          trigger={(
            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-sm
              text-[var(--ema-text-tertiary)] transition-opacity opacity-0 group-hover:opacity-100`}>
              ⋯
            </span>
          )}
        />
      </div>
      <ModelCover character={character} model={model} />
      <div className="px-3 py-2">
        <p className="truncate text-xs font-semibold text-[var(--ema-text-primary)]">{model.name}</p>
        <p className="truncate text-[11px] text-[var(--ema-text-tertiary)]">{model.displayName}</p>
        <p className="mt-1 text-[10px] text-[var(--ema-text-tertiary)]">{formatBytes(model.byteSize)}</p>
      </div>
    </div>
  );
}

function ModelCover({ character, model }: { character: Character; model: Live2dModel }): JSX.Element {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <div className="flex aspect-[3/4] w-full items-center justify-center bg-[var(--ema-surface-3)]">
        <span className="text-xs text-[var(--ema-text-tertiary)]">{model.name}</span>
      </div>
    );
  }
  return (
    <ServerImage
      path={charactersApi.live2dPreviewUrl(character.name, model.name)}
      alt={model.name}
      className="aspect-[3/4] w-full object-cover"
      onMissing={() => setMissing(true)}
    />
  );
}

// ── 单模型配置区(选中项的下面板) ───────────────────────────────────────────────

function ModelConfig({ character, model }: {
  character: Character;
  model: Live2dModel;
}): JSX.Element {
  const store = useCharacterStore();
  const [configuration, setConfiguration] = useState<(Live2dConfiguration & { entryPath: string }) | null>(null);
  const [scale, setScale] = useState(model.stageScale);
  const [offsetX, setOffsetX] = useState(model.stageOffsetX);
  const [offsetY, setOffsetY] = useState(model.stageOffsetY);
  const [savingStage, setSavingStage] = useState(false);

  // 映射草稿:语义词集合只读,只允许改原生目标
  const [emotionMap, setEmotionMap] = useState<Record<string, { expression: string }>>({});
  const [motionMap, setMotionMap] = useState<Record<string, { group: string; index: number }>>({});
  const [savingMappings, setSavingMappings] = useState(false);
  const [reloading, setReloading] = useState(false);

  const loadConfiguration = useCallback(async () => {
    try {
      const conf = await charactersApi.live2dConfiguration(character.name, model.name);
      setConfiguration(conf);
      setEmotionMap({ ...(conf.runtimeConfig.emotionMap ?? {}) });
      setMotionMap(Object.fromEntries(
        Object.entries(conf.runtimeConfig.motionMap ?? {})
          .map(([word, target]) => [word, { group: target.group, index: target.index ?? 0 }]),
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '配置读取失败', { variant: 'danger' });
    }
  }, [character.name, model.name]);

  useEffect(() => {
    void loadConfiguration();
  }, [loadConfiguration]);

  // 缺封面补票:拿到 entryPath 后离屏渲一帧存上
  // 预览源走 convertFileSrc(asset 协议):模型目录在 characters/** 白名单内,
  // HTTP files 路由要鉴权头而 pixi 加载器加不了头,所以不走它。
  useEffect(() => {
    if (!configuration?.entryPath) return;
    void (async () => {
      const previewUrl = await fetchServerObjectUrl(
        charactersApi.live2dPreviewUrl(character.name, model.name),
      );
      if (previewUrl) return;
      try {
        const { path: modelDir } = await charactersApi.live2dLocation(character.name, model.name);
        const entryUrl = tauriBridge.convertFileSrc(`${modelDir.replace(/[\/]+$/, '')}/${configuration.entryPath}`);
        const base64 = await renderLive2dPreview(entryUrl);
        await charactersApi.uploadLive2dPreview(character.name, model.name, base64);
      } catch { /* 补票失败就保留占位,下次再来 */ }
    })();
  }, [configuration, character.name, model.name]);

  const stageDirty = scale !== model.stageScale
    || offsetX !== model.stageOffsetX
    || offsetY !== model.stageOffsetY;

  const expressionOptions = useMemo(
    () => (configuration?.expressions ?? []).map(name => ({ value: name, label: name })),
    [configuration],
  );
  const motionOptions = useMemo(
    () => (configuration?.motions ?? []).map(m => ({
      value: `${m.group}/${m.index}`,
      label: `${m.group} / ${m.index}`,
    })),
    [configuration],
  );

  async function saveStage(): Promise<void> {
    setSavingStage(true);
    try {
      await store.patchLive2d(character.name, model.name, {
        stageScale: scale,
        stageOffsetX: offsetX,
        stageOffsetY: offsetY,
      });
      showToast('舞台位置已保存', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', { variant: 'danger' });
    } finally {
      setSavingStage(false);
    }
  }

  async function saveMappings(): Promise<void> {
    setSavingMappings(true);
    try {
      await charactersApi.saveLive2dMappings(character.name, model.name, {
        emotionMap,
        motionMap,
      });
      showToast('映射已保存,下一次演出即刻生效', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存映射失败', { variant: 'danger' });
    } finally {
      setSavingMappings(false);
    }
  }

  async function reloadConfig(): Promise<void> {
    setReloading(true);
    try {
      await charactersApi.reloadLive2dConfig(character.name, model.name);
      await loadConfiguration();
      showToast('已重新加载配置', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重新加载失败', { variant: 'danger' });
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{model.name}</span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">/ {model.displayName}</span>
        {model.isPrimary && <Badge variant="primary">主要模型 ●</Badge>}
      </div>

      <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
        <p className="mb-3 text-xs font-semibold text-[var(--ema-text-secondary)]">舞台位置</p>
        <div className="flex flex-col gap-3">
          <SliderRow label="缩放" min={0.1} max={5} step={0.05} value={scale} onChange={setScale} />
          <SliderRow label="X 偏移" min={-1} max={1} step={0.01} value={offsetX} onChange={setOffsetX} />
          <SliderRow label="Y 偏移" min={-1} max={1} step={0.01} value={offsetY} onChange={setOffsetY} />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setScale(1); setOffsetX(0); setOffsetY(0);
            }}
          >
            恢复初始值
          </Button>
          <Button variant="primary" size="sm" loading={savingStage} disabled={!stageDirty} onClick={() => void saveStage()}>
            应用
          </Button>
        </div>
      </div>

      {!configuration && (
        <div className="flex justify-center py-8"><Spinner size="md" /></div>
      )}
      {configuration && (
        <>
          <MappingSection
            title="表情映射"
            hint="语义词 → 该模型真实原生表情"
            words={emotionMap}
            options={expressionOptions}
            resolve={value => value.expression}
            onChange={(word, target) => setEmotionMap(prev => ({ ...prev, [word]: { expression: target } }))}
          />
          <MappingSection
            title="动作映射"
            hint="语义词 → 实际检测到的 motion group/index"
            words={motionMap}
            options={motionOptions}
            resolve={value => `${value.group}/${value.index ?? 0}`}
            onChange={(word, target) => {
              const [group, index] = target.split('/');
              setMotionMap(prev => ({ ...prev, [word]: { group: group!, index: Number(index) } }));
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" loading={reloading} onClick={() => void reloadConfig()}>
              重新加载配置
            </Button>
            <Button variant="primary" size="sm" loading={savingMappings} onClick={() => void saveMappings()}>
              保存映射
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function MappingSection<T>({
  title, hint, words, options, resolve, onChange,
}: {
  title: string;
  hint: string;
  words: Record<string, T>;
  options: Array<{ value: string; label: string }>;
  resolve(value: T): string;
  onChange(word: string, target: string): void;
}): JSX.Element {
  const entries = Object.entries(words) as Array<[string, T]>;
  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <p className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">{title}</p>
      <p className="mb-3 text-[11px] text-[var(--ema-text-tertiary)]">{hint}</p>
      {entries.length === 0 && (
        <p className="py-3 text-center text-[11px] text-[var(--ema-text-tertiary)]">暂无映射</p>
      )}
      {entries.map(([word, value]) => (
        <div key={word} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 border-b border-[var(--ema-border)] py-1.5 last:border-none">
          <span className="font-mono text-xs text-[var(--ema-info)]">{word}</span>
          <Select
            value={resolve(value)}
            options={options}
            onChange={target => onChange(word, target)}
          />
          <span
            className="cursor-not-allowed text-[11px] text-[var(--ema-text-tertiary)]"
            title="试播要走主窗口唯一 Canvas,联调批开放"
          >
            测试
          </span>
        </div>
      ))}
    </div>
  );
}

function SliderRow({ label, min, max, step, value, onChange }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
}): JSX.Element {
  // UI 包的 Slider 是离散 steps 制;按 min/max/step 现场生成。
  const steps = useMemo(() => {
    const result: Array<{ value: number; label: string }> = [];
    for (let v = min; v <= max + 1e-9; v += step) {
      result.push({ value: Number(v.toFixed(4)), label: '' });
    }
    return result;
  }, [min, max, step]);
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-[var(--ema-text-tertiary)]">{label}</span>
      <Slider<number>
        className="flex-1"
        steps={steps}
        value={value}
        onChange={onChange}
        hideLabels
      />
      <span className="w-12 text-right font-mono text-[11px] text-[var(--ema-text-tertiary)]">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

// ── 导入(ZIP 包 / 文件夹) ────────────────────────────────────────────────────

function ImportMenu({ character }: { character: Character }): JSX.Element {
  const store = useCharacterStore();
  const [importing, setImporting] = useState(false);

  async function runImport(source: string): Promise<void> {
    setImporting(true);
    try {
      const result = await store.importLive2d(character.name, { source });
      showToast(`已导入 ${result.name}`, { variant: 'success' });
      // 导入成功即离屏渲封面:asset URL 渲一帧 → 存 characterName/.previews/
      if (result.entryPath) {
        void (async () => {
          try {
            const { path: modelDir } = await charactersApi.live2dLocation(character.name, result.name);
            const entryUrl = tauriBridge.convertFileSrc(`${modelDir.replace(/[\/]+$/, '')}/${result.entryPath}`);
            const base64 = await renderLive2dPreview(entryUrl);
            await charactersApi.uploadLive2dPreview(character.name, result.name, base64);
          } catch { /* 封面失败不挡导入 */ }
        })();
      }
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再导入', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? error.message : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '导入 ZIP 包',
      icon: 'i-lucide:package',
      onSelect: () => {
        void (async () => {
          const source = await tauriBridge.openFileDialog({ filters: [{ name: 'Live2D ZIP', extensions: ['zip'] }] });
          if (source) await runImport(source);
        })();
      },
    },
    {
      kind: 'item',
      label: '导入文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void (async () => {
          const source = await tauriBridge.openFileDialog({ directory: true });
          if (source) await runImport(source);
        })();
      },
    },
  ];

  return (
    <DropdownMenu
      side="bottom"
      align="end"
      items={items}
      trigger={(
        <Button variant="primary" size="sm" icon="i-mdi:plus" loading={importing}>
          导入
        </Button>
      )}
    />
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
