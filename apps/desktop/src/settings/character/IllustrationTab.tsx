import { useMemo, useState, type JSX } from 'react';
import {
  Tooltip,
  Button, CursorFloating, Dialog, DropdownMenu, EmptyState, IconButton, Input, ScrollArea, Slider, Tabs,
  type MenuItem,
} from '@ema-agent/ui';
import {
  charactersApi,
  type Character,
} from '../../api/characters.js';
import { ServerApiError } from '../../api/client.js';
import { useCharacterStore } from '../../stores/character.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { ServerImage } from '../../lib/images/serverImage.js';
import { showToast } from '../../lib/notifications/toast.js';

import { ResourceOverview, ResourcePreview, ResourceView, resourceTableText } from './ResourceViews.js';

type Illustration = Character['illustrations'][number];

export function IllustrationTab({ character }: { character: Character }): JSX.Element {
  const [view, setView] = useState('grid');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<Illustration | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const store = useCharacterStore();
  const illustrations = character.illustrations;
  const mapped = illustrations.filter(item => item.expression).length;
  const visible = illustrations.filter(item =>
    filter === 'all' || (filter === 'mapped' ? !!item.expression : !item.expression));
  const groups = new Map<string, Illustration[]>();
  for (const item of visible) {
    const tag = item.expression ?? '未映射';
    const group = groups.get(tag) ?? [];
    group.push(item);
    groups.set(tag, group);
  }
  const overview = [
    '| 表情标签 | 图片预览 | 图片与配置 |',
    '| --- | --- | --- |',
    ...Array.from(groups, ([tag, items]) => {
      const images = items.map(item =>
        `![预览](${charactersApi.illustrationFileUrl(character.name, item.name)})`).join(' ');
      const names = items.map(item =>
        `[编辑](#edit-${encodeURIComponent(item.name)}) ${resourceTableText(item.displayName)}${item.isPrimary ? ' (主要插图)' : ''}`).join(' / ');
      return `| ${resourceTableText(tag)} | ${images} | ${names} |`;
    }),
  ].join('\n');

  async function handleImport(): Promise<void> {
    // 捕获当前角色; 文件选择期间用户可以切换页面, 导入目标仍保持不变.
    const characterName = character.name;
    setSelecting(true);
    try {
      const sources = await tauriBridge.selectPaths({
        title: `导入 ${characterName} 的插图`,
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      setSelecting(false);
      if (!sources.length) return;
      setImporting(true);
      let succeeded = 0;
      const failures: string[] = [];
      for (const sourceFile of sources) {
        try {
          await store.importIllustration(characterName, { sourceFile });
          succeeded += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : '导入失败');
        }
      }
      showToast(
        `已导入 ${succeeded} 张插图.${failures.length ? ` ${failures.length} 张失败: ${failures[0]}` : ''}`,
        { variant: failures.length ? 'warning' : 'success' },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择图片失败', { variant: 'danger' });
    } finally {
      setSelecting(false);
      setImporting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="ema-resource-header">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">插图</h3>
          <Button
            variant="primary"
            size="sm"
            loading={importing}
            disabled={selecting || importing}
            onClick={() => void handleImport()}
          >
            批量导入
          </Button>
        </div>
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          已映射 {mapped} 张, 未映射 {illustrations.length - mapped} 张
        </span>
        <div className="ema-resource-toolbar">
          <Tabs
            value={view}
            onChange={setView}
            variant="pill"
            triggersOnly
            items={[
              { value: 'grid', label: '图片网格', content: null },
              { value: 'overview', label: '配置总览', content: null },
            ]}
          />
          <Tabs
            className="ml-auto"
            value={filter}
            onChange={setFilter}
            variant="pill"
            triggersOnly
            items={[
              { value: 'all', label: '全部', content: null },
              { value: 'mapped', label: '已映射', content: null },
              { value: 'unmapped', label: '未映射', content: null },
            ]}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollbar="always">
        <div className="px-5 pb-5">
          {visible.length === 0 && <EmptyState title="没有符合条件的插图" hint="使用右上角批量导入图片." />}
          <div className="ema-resource-views">
            <ResourceView active={view === 'grid'}>
              <div className="ema-resource-grid">
                {visible.map((item, index) => (
                  <IllustrationCard
                    key={item.name}
                    character={character}
                    item={item}
                    index={index}
                    selected={false}
                    onSelect={() => setEditing(item)}
                  />
                ))}
              </div>
            </ResourceView>
            <ResourceView active={view === 'overview'}>
              <ResourceOverview
                source={overview}
                onEdit={name => setEditing(illustrations.find(item => item.name === name) ?? null)}
                onPreview={(src, name) => setPreview({ src, name })}
              />
            </ResourceView>
          </div>
        </div>
      </ScrollArea>
      <Dialog
        open={editing !== null}
        onOpenChange={open => { if (!open) setEditing(null); }}
        title="编辑插图"
        description="留空表情标签时, 图片仍可作为主要插图使用."
        widthClass="max-w-4xl"
      >
        {editing && (
          <IllustrationConfig
            key={editing.name}
            character={character}
            item={editing}
            onPreview={() => setPreview({
              src: charactersApi.illustrationFileUrl(character.name, editing.name),
              name: editing.displayName,
            })}
          />
        )}
      </Dialog>
      <ResourcePreview image={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

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
          .then(({ path }) => tauriBridge.revealInFolder(path))
          .catch(() => showToast('打开文件夹失败', { variant: 'danger' }));
      },
    },
    {
      kind: 'item',
      label: '导出',
      icon: 'i-solar:download-minimalistic-bold-duotone',
      onSelect: () => {
        void (async () => {
          try {
            const [destination] = await tauriBridge.selectPaths({ directory: true });
            if (!destination) return;
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
    <div className="ema-stagger-in" style={{ '--stagger-i': index } as React.CSSProperties}>
      <CursorFloating
        data-selected={selected || undefined}
        className={`ema-material-card group relative cursor-pointer overflow-hidden rounded-xl border
          hover:border-[var(--ema-primary)]/30 hover:shadow-[var(--ema-shadow-soft)]
          ${selected ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border)] bg-[var(--ema-surface-2)]'}`}
      >
      <div className="absolute left-2 top-2 z-10">
        <Tooltip content={item.isPrimary ? '主要插图' : '非主要插图'}>
          <span
            className={`block h-3.5 w-3.5 rounded-full border-2
              ${item.isPrimary
                ? 'border-[var(--ema-success)] bg-[var(--ema-success)] shadow-[var(--ema-shadow-1)]'
                : 'border-[var(--ema-border-strong)] bg-[var(--ema-surface-2)]'}`}
          />
        </Tooltip>
      </div>
      <div className="absolute right-2 top-2 z-10" onClick={event => event.stopPropagation()}>
        <DropdownMenu
          side="bottom"
          align="end"
          items={menuItems}
          trigger={(
            <IconButton
              icon="i-lucide:more-horizontal"
              label={`${item.displayName} 更多操作`}
              className="ema-resource-more"
            />
          )}
        />
      </div>
      <Button variant="ghost" className="block h-auto w-full p-0" onClick={onSelect} aria-label={`编辑 ${item.displayName}`}>
      <ServerImage
        path={charactersApi.illustrationFileUrl(character.name, item.name)}
        alt={item.name}
        className="aspect-[3/4] w-full object-contain p-3"
      />
      <div className="px-3 py-2">
        <p className="truncate text-xs font-semibold text-[var(--ema-text-primary)]">{item.displayName}</p>
        <p className="truncate text-[11px] text-[var(--ema-text-tertiary)]">
          {item.expression ? `表情: ${item.expression}` : '未映射'}
        </p>
        <p className="mt-1 text-[10px] text-[var(--ema-text-tertiary)]">{formatBytes(item.byteSize)}</p>
      </div>
      </Button>
      </CursorFloating>
    </div>
  );
}


function IllustrationConfig({ character, item, onPreview }: {
  character: Character;
  item: Illustration;
  onPreview(): void;
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
        <Button variant="ghost" className="h-auto p-0 self-start" onClick={onPreview}>
          <ServerImage
          path={charactersApi.illustrationFileUrl(character.name, item.name)}
          alt={item.name}
          className="w-40 shrink-0 self-start rounded-lg border border-[var(--ema-border)] object-contain"
        />
        </Button>
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
