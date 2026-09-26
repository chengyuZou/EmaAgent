// 插图 Tab:上资源列表(真缩略图)下单张配置,点列表切换;右上[导入图片]。
// expression 是自由文本(词法 [a-z][a-z0-9_]*),纯 Input 手写新词。
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button, DropdownMenu, IconButton, Input, ScrollArea, Slider, Spinner,
  type MenuItem,
} from '@ema-agent/ui';
import {
  charactersApi,
  type Character,
} from '../../api/characters.js';
import { ServerApiError } from '../../api/client.js';
import { useCharacterStore } from '../../stores/character.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { ServerImage } from '../../lib/ServerImage.js';
import { showToast } from '../../lib/toast.js';

type Illustration = Character['illustrations'][number];

export function IllustrationTab({ character }: { character: Character }): JSX.Element {
  const illustrations = character.illustrations;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = illustrations.find(item => item.name === selectedName)
    ?? illustrations.find(item => item.isPrimary)
    ?? illustrations[0];
  const [importing, setImporting] = useState(false);
  const store = useCharacterStore();

  async function handleImport(): Promise<void> {
    const sources = await tauriBridge.openFileDialogMultiple({
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (sources.length === 0) return;
    setImporting(true);
    try {
      for (const sourceFile of sources) {
        await store.importIllustration(character.name, { sourceFile });
      }
      showToast(`已导入 ${sources.length} 张插图`, { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">插图</h3>
        <Button variant="primary" size="sm" icon="i-mdi:plus" loading={importing} onClick={() => void handleImport()}>
          导入图片
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-5 pb-5">
          {illustrations.length === 0 && (
            <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">
              还没有插图,点右上角导入
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {illustrations.map((item, index) => (
              <IllustrationCard
                key={item.name}
                character={character}
                item={item}
                index={index}
                selected={selected?.name === item.name}
                onSelect={() => setSelectedName(item.name)}
              />
            ))}
          </div>
          {selected && (
            <IllustrationConfig
              key={selected.name}
              character={character}
              item={selected}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── 资源卡 ────────────────────────────────────────────────────────────────────

function IllustrationCard({
  character, item, index, selected, onSelect,
}: {
  character: Character;
  item: Illustration;
  index: number;
  selected: boolean;
  onSelect(): void;
}): JSX.Element {
  const store = useCharacterStore();

  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: item.isPrimary ? '主要插图' : '设为主要插图',
      icon: 'i-solar:star-bold-duotone',
      disabled: item.isPrimary,
      onSelect: () => {
        void store.setPrimaryIllustration(character.name, item.name)
          .catch(error => showToast(error instanceof Error ? error.message : '设置失败', { variant: 'danger' }));
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '打开文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void charactersApi.illustrationLocation(character.name, item.name)
          .then(({ path }) => charactersApi.revealFile(path))
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
            await charactersApi.exportIllustration(character.name, item.name, destination);
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
        void store.deleteIllustration(character.name, item.name)
          .then(() => showToast('已删除插图', { variant: 'success' }))
          .catch((error) => {
            if (error instanceof ServerApiError && error.code === 'character_work_running') {
              showToast('Session 活跃期间不能删除角色资源', { variant: 'warning' });
              return;
            }
            showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' });
          });
      },
    },
  ];

  return (
    <div
      className={`ema-stagger-in group relative cursor-pointer overflow-hidden rounded-xl border
        transition-all duration-[var(--ema-duration-base)] hover:border-[var(--ema-primary)]/30
        ${selected ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border)] bg-[var(--ema-surface-2)]'}`}
      style={{ '--stagger-i': index } as React.CSSProperties}
      onClick={onSelect}
    >
      <div className="absolute left-2 top-2 z-10">
        <span
          className={`block h-3.5 w-3.5 rounded-full border-2
            ${item.isPrimary
              ? 'border-[var(--ema-success)] bg-[var(--ema-success)] shadow-[var(--ema-shadow-1)]'
              : 'border-[var(--ema-border-strong)] bg-[var(--ema-surface-2)]'}`}
          title={item.isPrimary ? '主要插图' : '非主要插图'}
        />
      </div>
      <div className="absolute right-2 top-2 z-10" onClick={event => event.stopPropagation()}>
        <DropdownMenu
          side="bottom"
          align="end"
          items={menuItems}
          trigger={(
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md text-sm
              text-[var(--ema-text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100">
              ⋯
            </span>
          )}
        />
      </div>
      <ServerImage
        path={charactersApi.illustrationFileUrl(character.name, item.name)}
        alt={item.name}
        className="aspect-[3/4] w-full object-cover"
      />
      <div className="px-3 py-2">
        <p className="truncate text-xs font-semibold text-[var(--ema-text-primary)]">{item.name}</p>
        <p className="truncate text-[11px] text-[var(--ema-text-tertiary)]">
          {item.displayName}{item.expression ? ` · ${item.expression}` : ''}
        </p>
        <p className="mt-1 text-[10px] text-[var(--ema-text-tertiary)]">{formatBytes(item.byteSize)}</p>
      </div>
    </div>
  );
}

// ── 单张配置区 ────────────────────────────────────────────────────────────────

function IllustrationConfig({ character, item }: {
  character: Character;
  item: Illustration;
}): JSX.Element {
  const store = useCharacterStore();
  const [displayName, setDisplayName] = useState(item.displayName);
  const [expression, setExpression] = useState(item.expression ?? '');
  const [scale, setScale] = useState(item.stageScale);
  const [offsetX, setOffsetX] = useState(item.stageOffsetX);
  const [offsetY, setOffsetY] = useState(item.stageOffsetY);
  const [saving, setSaving] = useState(false);

  const dirty = displayName !== item.displayName
    || (expression || null) !== item.expression
    || scale !== item.stageScale
    || offsetX !== item.stageOffsetX
    || offsetY !== item.stageOffsetY;

  async function handleSave(): Promise<void> {
    const word = expression.trim();
    if (word && !/^[a-z][a-z0-9_]*$/.test(word)) {
      showToast('expression 只能是小写字母开头的英文词(如 happy、sad、soft_smile)', { variant: 'warning' });
      return;
    }
    setSaving(true);
    try {
      await store.patchIllustration(character.name, item.name, {
        displayName: displayName.trim(),
        expression: word || null,
        stageScale: scale,
        stageOffsetX: offsetX,
        stageOffsetY: offsetY,
      });
      showToast('已保存', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <div className="flex flex-col gap-4 md:flex-row">
        <ServerImage
          path={charactersApi.illustrationFileUrl(character.name, item.name)}
          alt={item.name}
          className="w-40 shrink-0 self-start rounded-lg border border-[var(--ema-border)] object-cover"
        />
        <div className="flex flex-1 flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-[var(--ema-text-tertiary)]">展示名</span>
            <Input mono={false} value={displayName} onChange={e => setDisplayName(e.target.value)} className="flex-1" />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-[var(--ema-text-tertiary)]">expression</span>
            <div className="flex-1">
              <Input
                value={expression}
                onChange={e => setExpression(e.target.value)}
                className="w-full"
                placeholder="留空 = 不参与表情池"
              />
            </div>
          </div>
          <IllustrationSlider label="缩放" min={0.1} max={5} step={0.05} value={scale} onChange={setScale} />
          <IllustrationSlider label="X 偏移" min={-1} max={1} step={0.01} value={offsetX} onChange={setOffsetX} />
          <IllustrationSlider label="Y 偏移" min={-1} max={1} step={0.01} value={offsetY} onChange={setOffsetY} />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={() => void handleSave()}>
          保存修改
        </Button>
      </div>
    </div>
  );
}

function IllustrationSlider({ label, min, max, step, value, onChange }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
}): JSX.Element {
  const steps = useMemo(() => {
    const result: Array<{ value: number; label: string }> = [];
    for (let v = min; v <= max + 1e-9; v += step) {
      result.push({ value: Number(v.toFixed(4)), label: '' });
    }
    return result;
  }, [min, max, step]);
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-[var(--ema-text-tertiary)]">{label}</span>
      <Slider<number> className="flex-1" steps={steps} value={value} onChange={onChange} hideLabels />
      <span className="w-12 text-right font-mono text-[11px] text-[var(--ema-text-tertiary)]">{value.toFixed(2)}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
