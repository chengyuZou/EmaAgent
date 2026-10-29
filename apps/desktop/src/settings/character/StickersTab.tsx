import { useState, type JSX } from 'react';
import { CHARACTER_STICKER_PROMPT_MAX_CHARS } from '@ema-agent/characters/stickers';
import {
  Badge, Button, Callout, ConfirmDialog, Dialog, DropdownMenu, EmptyState,
  Field, IconButton, Input, ScrollArea, Tabs, Textarea, type MenuItem,
} from '@ema-agent/ui';
import { charactersApi, type Character } from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { showToast } from '../../lib/notifications/toast.js';
import { ResourceImage, ResourceOverview, ResourcePreview, ResourceView, resourceTableText } from './ResourceViews.js';

type Sticker = Character['stickers'][number];

export function StickersTab({ character }: { character: Character }): JSX.Element {
  const [view, setView] = useState('grid');
  const [filter, setFilter] = useState('all');
  const [importing, setImporting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [editing, setEditing] = useState<Sticker | null>(null);
  const [deleting, setDeleting] = useState<Sticker | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const items = character.stickers;
  const ready = items.filter(item => item.description.trim()).length;
  const visible = items.filter(item => filter === 'all' || !item.description.trim());
  const fileUrl = (item: Sticker) => charactersApi.stickerFileUrl(character.name, item.name);
  const reload = () => useCharacterStore.getState().load();

  async function importImages(): Promise<void> {
    // 文件选择期间允许切页. 返回后仍写入打开选择框时的角色, 不读取后来激活的角色.
    const characterName = character.name;
    setSelecting(true);
    try {
      const sources = await tauriBridge.selectPaths({
        title: '批量导入表情包',
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      setSelecting(false);
      if (sources.length === 0) return;
      setImporting(true);
      let succeeded = 0;
      const failures: string[] = [];
      for (const sourceFile of sources) {
        try {
          await charactersApi.importSticker(characterName, { sourceFile });
          succeeded += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : '导入失败');
        }
      }
      await reload();
      showToast(
        `已导入 ${succeeded} 张, 请补充描述后使用.${failures.length ? ` ${failures.length} 张失败: ${failures[0]}` : ''}`,
        { variant: failures.length ? 'warning' : 'success' },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择图片失败', { variant: 'danger' });
    } finally {
      setSelecting(false);
      setImporting(false);
    }
  }

  async function exportImage(item: Sticker): Promise<void> {
    try {
      const [destination] = await tauriBridge.selectPaths({ directory: true });
      if (!destination) return;
      await charactersApi.exportSticker(character.name, item.name, destination);
      showToast('已导出', { variant: 'success' });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出失败', { variant: 'danger' });
    }
  }

  function menu(item: Sticker): MenuItem[] {
    return [
      { kind: 'item', label: '编辑', onSelect: () => setEditing(item) },
      { kind: 'item', label: '打开文件夹', onSelect: () => {
        void charactersApi.stickerLocation(character.name, item.name)
          .then(result => tauriBridge.revealInFolder(result.path))
          .catch(error => showToast(error instanceof Error ? error.message : '打开失败', { variant: 'danger' }));
      } },
      { kind: 'item', label: '导出', onSelect: () => { void exportImage(item); } },
      { kind: 'separator' },
      { kind: 'item', label: '删除', onSelect: () => setDeleting(item) },
    ];
  }

  async function deleteImage(): Promise<void> {
    if (!deleting) return;
    try {
      await charactersApi.deleteSticker(character.name, deleting.name);
      setDeleting(null);
      await reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' });
    }
  }

  const overview = [
    '| 图片 | 名称 | 描述 | 操作 |',
    '| --- | --- | --- | --- |',
    ...visible.map(item =>
      `| ![图片](${fileUrl(item)}) | ${resourceTableText(item.displayName)} | ${resourceTableText(item.description || '待补描述')} | [编辑](#edit-${encodeURIComponent(item.name)}) |`),
  ].join('\n');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="ema-resource-header">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">表情包</h3>
          <Button
            variant="primary"
            size="sm"
            loading={importing}
            disabled={selecting || importing}
            onClick={() => void importImages()}
          >
            批量导入
          </Button>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-[var(--ema-text-tertiary)]">
          <span>已就绪 {ready} 张, 待补描述 {items.length - ready} 张</span>
          <span className="ml-auto tabular-nums">
            目前 {character.stickerPromptLength.toLocaleString()} / {CHARACTER_STICKER_PROMPT_MAX_CHARS.toLocaleString()} 字符
          </span>
        </div>
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
              { value: 'missing', label: '待补描述', content: null },
            ]}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" scrollbar="always">
        <div className="px-5 pb-5">
          {items.length !== ready && (
            <Callout variant="info" className="mb-4">
              新导入的图片需要填写描述, 角色才能使用. 点击卡片填写图片内容和适合使用的场景.
            </Callout>
          )}
          {visible.length === 0 && (
            <EmptyState title={items.length ? '没有待补描述的表情包' : '还没有表情包'} hint="使用右上角批量导入图片." />
          )}
          <div className="ema-resource-views">
            <ResourceView active={view === 'grid'}>
              <div className="ema-resource-grid">
                {visible.map(item => (
                  <div className="ema-resource-card" key={item.name}>
                    <DropdownMenu
                      align="end"
                      items={menu(item)}
                      trigger={<IconButton className="ema-resource-more" icon="i-lucide:more-horizontal" label={`${item.displayName} 更多操作`} />}
                    />
                    <Button
                      variant="ghost"
                      className="ema-resource-image-button"
                      onClick={() => setEditing(item)}
                      aria-label={`编辑 ${item.displayName}`}
                    >
                      <ResourceImage src={fileUrl(item)} name={item.displayName} className="aspect-square w-full" />
                    </Button>
                    <div className="flex flex-col gap-1 px-3 pb-3">
                      <span className="truncate text-sm font-medium">{item.displayName}</span>
                      {item.description
                        ? <span className="line-clamp-2 text-xs text-[var(--ema-text-secondary)]">{item.description}</span>
                        : <Badge>待补描述</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            </ResourceView>
            <ResourceView active={view === 'overview'}>
              <ResourceOverview
                source={overview}
                onEdit={name => setEditing(items.find(item => item.name === name) ?? null)}
                onPreview={(src, name) => setPreview({ src, name })}
              />
            </ResourceView>
          </div>
        </div>
      </ScrollArea>
      <StickerEditor
        key={editing?.name ?? 'closed'}
        characterName={character.name}
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={reload}
        onPreview={item => setPreview({ src: fileUrl(item), name: item.displayName })}
      />
      <ResourcePreview image={preview} onClose={() => setPreview(null)} />
      <ConfirmDialog
        open={deleting !== null}
        title="删除表情包"
        message="删除图片后, 以前回复中引用它的位置可能显示图片无法加载."
        confirmText="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => void deleteImage()}
      />
    </div>
  );
}

function StickerEditor({ characterName, item, onClose, onSaved, onPreview }: {
  characterName: string;
  item: Sticker | null;
  onClose(): void;
  onSaved(): Promise<void>;
  onPreview(item: Sticker): void;
}): JSX.Element {
  const [displayName, setDisplayName] = useState(item?.displayName ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!item) return;
    setSaving(true);
    setError(null);
    try {
      await charactersApi.patchSticker(characterName, item.name, { displayName, description });
      await onSaved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={item !== null}
      onOpenChange={open => { if (!open && !saving) onClose(); }}
      title="编辑表情包"
      widthClass="max-w-4xl"
    >
      {item && (
        <div className="grid gap-5 md:grid-cols-2">
          <Button variant="ghost" className="h-auto p-0" onClick={() => onPreview(item)}>
            <ResourceImage
              src={charactersApi.stickerFileUrl(characterName, item.name)}
              name={item.displayName}
              className="h-72 w-full"
            />
          </Button>
          <div className="flex min-w-0 flex-col gap-4">
            <Field label="名称" required>
              <Input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={200} />
            </Field>
            <Field label="描述" description="填写图片内容和适用语境. 留空时角色不会使用这张图片.">
              <Textarea
                value={description}
                onChange={event => setDescription(event.target.value)}
                className="min-h-44"
                maxLength={CHARACTER_STICKER_PROMPT_MAX_CHARS}
              />
            </Field>
            {error && <Callout variant="danger">{error}</Callout>}
          </div>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
        <Button variant="primary" loading={saving} disabled={!displayName.trim()} onClick={() => void save()}>保存</Button>
      </div>
    </Dialog>
  );
}
