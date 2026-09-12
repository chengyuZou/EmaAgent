// 编辑单个 Live2D 模型的舞台位置、原生资源清单与语义映射。
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  IconButton,
  Input,
  Select,
  Slider,
  Spinner,
} from '@ema-agent/ui';
import {
  charactersApi,
  type Character,
  type Live2dConfiguration,
} from '../../api/characters.js';
import { tauriBridge, type Live2dPreviewCommand } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useCharacterStore } from '../../stores/character.js';

type Live2dModel = Character['live2dModels'][number];
type MotionTarget = { group: string; index: number };

export function Live2dModelConfiguration({
  character,
  model,
}: {
  character: Character;
  model: Live2dModel;
}): JSX.Element {
  const store = useCharacterStore();
  const [configuration, setConfiguration] = useState<Live2dConfiguration | null>(null);
  const [scale, setScale] = useState(model.stageScale);
  const [offsetX, setOffsetX] = useState(model.stageOffsetX);
  const [offsetY, setOffsetY] = useState(model.stageOffsetY);
  const [savingStage, setSavingStage] = useState(false);
  const [emotionMap, setEmotionMap] = useState<Record<string, { expression: string }>>({});
  const [motionMap, setMotionMap] = useState<Record<string, MotionTarget>>({});
  const [savingMappings, setSavingMappings] = useState(false);
  const [reloading, setReloading] = useState(false);

  const loadConfiguration = useCallback(async () => {
    try {
      const next = await charactersApi.live2dConfiguration(character.name, model.name);
      setConfiguration(next);
      setEmotionMap({ ...(next.runtimeConfig.emotionMap ?? {}) });
      setMotionMap(Object.fromEntries(
        Object.entries(next.runtimeConfig.motionMap ?? {}).map(([word, target]) => [
          word,
          { group: target.group, index: target.index },
        ]),
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '配置读取失败', { variant: 'danger' });
    }
  }, [character.name, model.name]);

  useEffect(() => {
    void loadConfiguration();
  }, [loadConfiguration]);

  const expressionOptions = useMemo(
    () => (configuration?.expressions ?? []).map(item => ({
      value: item.expression,
      label: item.expression,
    })),
    [configuration],
  );
  const motionOptions = useMemo(
    () => (configuration?.motions ?? []).map(motion => ({
      value: encodeMotion(motion.group, motion.index),
      label: `${motion.group} / ${motion.index}`,
    })),
    [configuration],
  );

  async function saveStage(
    nextScale: number,
    nextOffsetX: number,
    nextOffsetY: number,
  ): Promise<void> {
    if (
      nextScale === model.stageScale
      && nextOffsetX === model.stageOffsetX
      && nextOffsetY === model.stageOffsetY
    ) return;
    setSavingStage(true);
    try {
      await store.patchLive2d(character.name, model.name, {
        stageScale: nextScale,
        stageOffsetX: nextOffsetX,
        stageOffsetY: nextOffsetY,
      });
    } catch (error) {
      setScale(model.stageScale);
      setOffsetX(model.stageOffsetX);
      setOffsetY(model.stageOffsetY);
      await preview({
        type: 'placement',
        stageScale: model.stageScale,
        stageOffsetX: model.stageOffsetX,
        stageOffsetY: model.stageOffsetY,
      });
      showToast(error instanceof Error ? error.message : '保存失败', { variant: 'danger' });
    } finally {
      setSavingStage(false);
    }
  }

  function updatePlacement(
    nextScale: number,
    nextOffsetX: number,
    nextOffsetY: number,
  ): void {
    setScale(nextScale);
    setOffsetX(nextOffsetX);
    setOffsetY(nextOffsetY);
    void preview({
      type: 'placement',
      stageScale: nextScale,
      stageOffsetX: nextOffsetX,
      stageOffsetY: nextOffsetY,
    });
  }

  async function saveMappings(): Promise<void> {
    setSavingMappings(true);
    try {
      const saved = await charactersApi.saveLive2dMappings(character.name, model.name, {
        emotionMap,
        motionMap,
      });
      setConfiguration(saved);
      showToast('映射已保存,下一次演出即刻生效', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存映射失败', { variant: 'danger' });
    } finally {
      setSavingMappings(false);
    }
  }

  async function reloadConfiguration(): Promise<void> {
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

  async function preview(command: Live2dPreviewCommand): Promise<void> {
    try {
      await tauriBridge.publishLive2dPreview(command);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Live2D 预览失败', { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{model.name}</span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">/ {model.displayName}</span>
        {model.isPrimary && <Badge variant="primary">主要模型 ●</Badge>}
      </div>

      <StagePositionSection
        scale={scale}
        offsetX={offsetX}
        offsetY={offsetY}
        saving={savingStage}
        onScaleChange={nextScale => updatePlacement(nextScale, offsetX, offsetY)}
        onOffsetXChange={nextOffsetX => updatePlacement(scale, nextOffsetX, offsetY)}
        onOffsetYChange={nextOffsetY => updatePlacement(scale, offsetX, nextOffsetY)}
        onScaleCommit={nextScale => void saveStage(nextScale, offsetX, offsetY)}
        onOffsetXCommit={nextOffsetX => void saveStage(scale, nextOffsetX, offsetY)}
        onOffsetYCommit={nextOffsetY => void saveStage(scale, offsetX, nextOffsetY)}
        onReset={() => {
          updatePlacement(1, 0, 0);
          void saveStage(1, 0, 0);
        }}
      />

      {!configuration && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}
      {configuration && (
        <>
          <NativeResourceSection
            configuration={configuration}
            onPreviewExpression={expression => void preview({ type: 'expression', expression })}
            onPreviewMotion={(group, index) => void preview({ type: 'motion', group, index })}
          />
          <MappingSection
            title="表情映射"
            hint="语义词 → 该模型正式登记的表情"
            words={emotionMap}
            options={expressionOptions}
            resolve={value => value.expression}
            onChange={(word, expression) => {
              setEmotionMap(current => ({ ...current, [word]: { expression } }));
            }}
            onAdd={(word) => {
              setEmotionMap(current => ({
                ...current,
                [word]: { expression: expressionOptions[0]!.value },
              }));
            }}
            onRemove={(word) => {
              setEmotionMap(current => Object.fromEntries(
                Object.entries(current).filter(([name]) => name !== word),
              ));
            }}
            onPreview={expression => void preview({ type: 'expression', expression })}
          />
          <MappingSection
            title="动作映射"
            hint="语义词 → 该模型正式登记的动作"
            words={motionMap}
            options={motionOptions}
            resolve={value => encodeMotion(value.group, value.index)}
            onChange={(word, target) => {
              setMotionMap(current => ({ ...current, [word]: decodeMotion(target) }));
            }}
            onAdd={(word) => {
              setMotionMap(current => ({
                ...current,
                [word]: decodeMotion(motionOptions[0]!.value),
              }));
            }}
            onRemove={(word) => {
              setMotionMap(current => Object.fromEntries(
                Object.entries(current).filter(([name]) => name !== word),
              ));
            }}
            onPreview={(target) => {
              const motion = decodeMotion(target);
              void preview({ type: 'motion', group: motion.group, index: motion.index });
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={reloading}
              onClick={() => void reloadConfiguration()}
            >
              重新加载配置
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={savingMappings}
              onClick={() => void saveMappings()}
            >
              保存映射
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function StagePositionSection({
  scale,
  offsetX,
  offsetY,
  saving,
  onScaleChange,
  onOffsetXChange,
  onOffsetYChange,
  onScaleCommit,
  onOffsetXCommit,
  onOffsetYCommit,
  onReset,
}: {
  scale: number;
  offsetX: number;
  offsetY: number;
  saving: boolean;
  onScaleChange(value: number): void;
  onOffsetXChange(value: number): void;
  onOffsetYChange(value: number): void;
  onScaleCommit(value: number): void;
  onOffsetXCommit(value: number): void;
  onOffsetYCommit(value: number): void;
  onReset(): void;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <p className="mb-3 text-xs font-semibold text-[var(--ema-text-secondary)]">舞台位置</p>
      <div className="flex flex-col gap-3">
        <SliderRow
          label="缩放"
          min={0.1}
          max={5}
          step={0.05}
          value={scale}
          onChange={onScaleChange}
          onCommit={onScaleCommit}
        />
        <SliderRow
          label="X 偏移"
        min={-1}
        max={1}
          step={0.01}
          value={offsetX}
          onChange={onOffsetXChange}
          onCommit={onOffsetXCommit}
        />
        <SliderRow
          label="Y 偏移"
        min={-1}
        max={1}
          step={0.01}
          value={offsetY}
          onChange={onOffsetYChange}
          onCommit={onOffsetYCommit}
        />
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-[11px] text-[var(--ema-text-tertiary)]">
          {saving ? '正在保存…' : '松开滑块后自动保存'}
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>
          恢复初始值
        </Button>
      </div>
    </div>
  );
}

function MappingSection<T>({
  title,
  hint,
  words,
  options,
  resolve,
  onChange,
  onAdd,
  onRemove,
  onPreview,
}: {
  title: string;
  hint: string;
  words: Record<string, T>;
  options: Array<{ value: string; label: string }>;
  resolve(value: T): string;
  onChange(word: string, target: string): void;
  onAdd(word: string): void;
  onRemove(word: string): void;
  onPreview(target: string): void;
}): JSX.Element {
  const [newWord, setNewWord] = useState('');
  const entries = Object.entries(words) as Array<[string, T]>;
  const canAdd = /^[a-z][a-z0-9_]*$/u.test(newWord)
    && !(newWord in words)
    && options.length > 0;
  const addWord = (): void => {
    if (!canAdd) return;
    onAdd(newWord);
    setNewWord('');
  };

  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <p className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">{title}</p>
      <p className="mb-3 text-[11px] text-[var(--ema-text-tertiary)]">{hint}</p>
      <div className="mb-3 flex gap-2">
        <Input
          value={newWord}
          placeholder="例如 sad"
          onChange={event => setNewWord(event.target.value.toLowerCase())}
          onKeyDown={event => {
            if (event.key === 'Enter') addWord();
          }}
        />
        <Button size="sm" variant="secondary" disabled={!canAdd} onClick={addWord}>
          添加
        </Button>
      </div>
      {entries.length === 0 && (
        <p className="py-3 text-center text-[11px] text-[var(--ema-text-tertiary)]">暂无映射</p>
      )}
      {entries.map(([word, value]) => (
        <div
          key={word}
          className="grid grid-cols-[120px_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-[var(--ema-border)] py-1.5 last:border-none"
        >
          <span className="font-mono text-xs text-[var(--ema-info)]">{word}</span>
          <Select
            value={resolve(value)}
            options={options}
            onChange={target => onChange(word, target)}
          />
          <Button size="sm" variant="ghost" onClick={() => onPreview(resolve(value))}>
            预览
          </Button>
          <IconButton
            size="sm"
            label={`删除 ${word}`}
            icon="i-mdi:delete-outline"
            onClick={() => onRemove(word)}
          />
        </div>
      ))}
    </div>
  );
}

interface NativeResourceSectionProps {
  configuration: Live2dConfiguration;
  onPreviewExpression(expression: string): void;
  onPreviewMotion(group: string, index: number): void;
}

function NativeResourceSection({
  configuration,
  onPreviewExpression,
  onPreviewMotion,
}: NativeResourceSectionProps): JSX.Element {
  const expressions: NativeResourceItem[] = [
    ...configuration.expressions.map(item => ({
      file: item.file,
      identity: item.expression,
      onPreview: () => onPreviewExpression(item.expression),
    })),
    ...configuration.unregisteredExpressionFiles.map(file => ({ file, identity: null })),
  ];
  const motions: NativeResourceItem[] = [
    ...configuration.motions.map(item => ({
      file: item.file,
      identity: `${item.group} / ${item.index}`,
      onPreview: () => onPreviewMotion(item.group, item.index),
    })),
    ...configuration.unregisteredMotionFiles.map(file => ({ file, identity: null })),
  ];

  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <p className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">原生资源</p>
      <p className="mb-3 text-[11px] text-[var(--ema-text-tertiary)]">
        未登记文件只展示路径,不能预览或保存为语义映射.
      </p>
      <NativeResourceList title="Expressions" items={expressions} />
      <NativeResourceList title="Motions" items={motions} />
    </div>
  );
}

interface NativeResourceItem {
  readonly file: string;
  readonly identity: string | null;
  readonly onPreview?: () => void;
}

function NativeResourceList({ title, items }: {
  title: string;
  items: readonly NativeResourceItem[];
}): JSX.Element {
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-semibold text-[var(--ema-text-tertiary)]">
        {title} · {items.length}
      </p>
      <div className="flex flex-col">
        {items.map(item => (
          <div
            key={item.file}
            className="grid grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-2 border-b border-[var(--ema-border)] py-1.5 last:border-none"
          >
            <span
              className="truncate font-mono text-[11px] text-[var(--ema-text-secondary)]"
              title={item.file}
            >
              {item.file}
            </span>
            {item.identity === null
              ? <Badge variant="neutral">未登记</Badge>
              : (
                  <span
                    className="truncate text-[11px] text-[var(--ema-info)]"
                    title={item.identity}
                  >
                    {item.identity}
                  </span>
                )}
            {item.onPreview && (
              <Button size="sm" variant="ghost" onClick={item.onPreview}>
                预览
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SliderRow({ label, min, max, step, value, onChange, onCommit }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
  onCommit(value: number): void;
}): JSX.Element {
  const steps = useMemo(() => {
    const result: Array<{ value: number; label: string }> = [];
    for (let current = min; current <= max + 1e-9; current += step) {
      result.push({ value: Number(current.toFixed(4)), label: '' });
    }
    return result;
  }, [max, min, step]);

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-[var(--ema-text-tertiary)]">{label}</span>
      <Slider<number>
        className="flex-1"
        steps={steps}
        value={value}
        onChange={onChange}
        onCommit={onCommit}
        hideLabels
      />
      <span className="w-12 text-right font-mono text-[11px] text-[var(--ema-text-tertiary)]">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function encodeMotion(group: string, index: number): string {
  return JSON.stringify([group, index]);
}

function decodeMotion(value: string): MotionTarget {
  const [group, index] = JSON.parse(value) as [string, number];
  return { group, index };
}
