// L1 角色卡网格:封面=当前舞台资源的真图(Live2D preview.png/主立绘/blank 素底),
// ●○切换、悬停删除、新建卡收尾。当前角色有工作在跑时拒绝切换/删除(先停再来)。
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button, Callout, Dialog, IconButton, Input, ScrollArea, Skeleton,
} from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import {
  charactersApi,
  type Character,
  type CharacterCreateInput,
} from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { ServerImage } from '../../lib/ServerImage.js';
import { showToast } from '../../lib/toast.js';

export function CharacterGridPage({ onOpen }: { onOpen(name: string): void }): JSX.Element {
  const characters = useCharacterStore(s => s.characters);
  const activeName = useCharacterStore(s => s.activeName);
  const loading = useCharacterStore(s => s.loading);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void useCharacterStore.getState().load();
  }, []);

  // 搜索角色
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return characters;
    return characters.filter(c =>
      c.name.toLowerCase().includes(keyword)
      || (c.displayName ?? '').toLowerCase().includes(keyword),
    );
  }, [characters, search]);

  // 如果当前角色有Session在跑 或者 TTS 仍在生成则拒绝激活
  // 但 Memory 后台清理不会阻塞删除
  async function handleActivate(name: string): Promise<void> {
    try {
      await useCharacterStore.getState().activate(name);
      showToast('已切换角色', { variant: 'success' });
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再切换', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? `切换失败:${error.message}` : '切换失败', { variant: 'danger' });
    }
  }

  const [pendingDelete, setPendingDelete] = useState<Character | null>(null);

  // 如果当前角色有Session在跑 或者 TTS 仍在生成则删除拒绝
  // 但 Memory 后台清理不会阻塞删除
  async function confirmDelete(): Promise<void> {
    const character = pendingDelete;
    if (!character) return;
    setPendingDelete(null);
    try {
      await useCharacterStore.getState().remove(character.name);
      showToast(`已删除 ${character.displayName ?? character.name}`, { variant: 'success' });
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再删除', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? `删除失败:${error.message}` : '删除失败', { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between gap-3 px-1 pb-3 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">角色卡</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">管理角色身份及其舞台资源</p>
        </div>
        <Input
          inputSize="sm"
          placeholder="搜索角色..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-56"
        />
      </div>

      <ScrollArea className="flex-1" viewportClassName="pb-2">
        {loading && characters.length === 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 pr-1">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-64 rounded-xl" />)}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <p className="text-xs text-[var(--ema-text-tertiary)] text-center py-10">
            {search ? '没有匹配的角色' : '还没有角色'}
          </p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 pr-1">
          {filtered.map((character, index) => (
            <CharacterCard
              key={character.name}
              character={character}
              index={index}
              isActive={character.name === activeName}
              canDelete={characters.length > 1}
              onOpen={() => onOpen(character.name)}
              onActivate={() => void handleActivate(character.name)}
              onDelete={() => setPendingDelete(character)}
            />
          ))}
          <button
            type="button"
            className="ema-stagger-in flex min-h-64 flex-col items-center justify-center gap-2 rounded-xl
              border border-dashed border-[var(--ema-border-strong)] text-[var(--ema-text-tertiary)]
              transition-colors hover:border-[var(--ema-primary)] hover:text-[var(--ema-text-primary)]"
            style={{ '--stagger-i': filtered.length } as React.CSSProperties}
            onClick={() => setCreateOpen(true)}
          >
            <span className="i-mdi:plus text-3xl" aria-hidden />
            <span className="text-sm">新建角色卡</span>
            <span className="text-[11px]">从名称和人设开始创建</span>
          </button>
        </div>
      </ScrollArea>

      <CreateCharacterDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onOpen} />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={open => { if (!open) setPendingDelete(null); }}
        title={`删除角色「${pendingDelete?.displayName ?? pendingDelete?.name ?? ''}」`}
        description="永久删除角色及其全部资源(Live2D/插图/参考音频)。Relationship Memory 不随之删除。"
        widthClass="max-w-md"
      >
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => setPendingDelete(null)}>取消</Button>
          <Button variant="danger" onClick={() => void confirmDelete()}>永久删除</Button>
        </div>
      </Dialog>
    </div>
  );
}

// ── 单张角色卡 ────────────────────────────────────────────────────────────────

function CharacterCard({
  character, index, isActive, canDelete, onOpen, onActivate, onDelete,
}: {
  character: Character;
  index: number;
  isActive: boolean;
  canDelete: boolean;
  onOpen(): void;
  onActivate(): void;
  onDelete(): void;
}): JSX.Element {
  return (
    <div
      className="ema-stagger-in group relative cursor-pointer overflow-hidden rounded-xl border
        border-[var(--ema-border)] bg-[var(--ema-surface-2)] shadow-[var(--ema-shadow-1)]
        transition-all duration-[var(--ema-duration-base)]
        hover:-translate-y-0.5 hover:border-[var(--ema-border-strong)] hover:shadow-[var(--ema-shadow-soft)]"
      style={{ '--stagger-i': index } as React.CSSProperties}
      onClick={onOpen}
    >
      <button
        type="button"
        className={`absolute left-2 top-2 z-10 h-4 w-4 rounded-full border-2 transition-all
          ${isActive
            ? 'border-[var(--ema-success)] bg-[var(--ema-success)] shadow-[0_0_8px_oklch(0.68_0.16_145/0.6)]'
            : 'border-[var(--ema-text-tertiary)] bg-transparent hover:border-[var(--ema-text-secondary)]'}`}
        title={isActive ? '当前角色' : '设为当前角色'}
        onClick={event => { event.stopPropagation(); if (!isActive) onActivate(); }}
      />
      {canDelete && (
        <div
          className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={event => event.stopPropagation()}
        >
          <IconButton
            icon="i-solar:trash-bin-trash-bold-duotone"
            label={`删除 ${character.displayName ?? character.name}`}
            size="sm"
            onClick={onDelete}
          />
        </div>
      )}
      <CharacterCover character={character} />
      <div className="px-3 py-2.5">
        <p className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">
          {character.name}{character.displayName ? ` (${character.displayName})` : ''}
        </p>
        {character.description && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--ema-text-tertiary)]">{character.description}</p>
        )}
        <div className="mt-1.5 flex gap-2.5 text-[10px] text-[var(--ema-text-tertiary)]">
          {character.live2dModels.length > 0 && <span>Live2D {character.live2dModels.length}</span>}
          {character.illustrations.length > 0 && <span>插图 {character.illustrations.length}</span>}
          <span>音频 {character.voiceSamples.length}</span>
        </div>
      </div>
    </div>
  );
}

/** 封面=当前舞台资源的真图:live2d→主模型 preview.png,illustration→主立绘,blank→素底 */
function CharacterCover({ character }: { character: Character }): JSX.Element {
  if (character.stageKind === 'live2d') {
    const primary = character.live2dModels.find(model => model.isPrimary);
    if (primary) {
      return (
        <ServerImage
          path={charactersApi.live2dPreviewUrl(character.name, primary.name)}
          alt={character.name}
          className="aspect-[3/4] w-full object-cover"
        />
      );
    }
  }
  if (character.stageKind === 'illustration') {
    const primary = character.illustrations.find(item => item.isPrimary)
      ?? character.illustrations[0];
    if (primary) {
      return (
        <ServerImage
          path={charactersApi.illustrationFileUrl(character.name, primary.name)}
          alt={character.name}
          className="aspect-[3/4] w-full object-cover"
        />
      );
    }
  }
  return (
    <div className="flex aspect-[3/4] w-full items-center justify-center bg-[var(--ema-surface-3)]">
    </div>
  );
}

// ── 新建 ─────────────────────────────────────────────────────────────────────

function CreateCharacterDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  onCreated(name: string): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [personaPrompt, setPersonaPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleCreate(): Promise<void> {
    if (!name.trim() || !personaPrompt.trim()) return;
    setSaving(true);
    try {
      const input: CharacterCreateInput = {
        name: name.trim(),
        personaPrompt: personaPrompt.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      const character = await useCharacterStore.getState().create(input);
      showToast('角色已创建', { variant: 'success' });
      setName(''); setDisplayName(''); setDescription(''); setPersonaPrompt('');
      onOpenChange(false);
      onCreated(character.name);
    } catch (error) {
      showToast(error instanceof Error ? `创建失败:${error.message}` : '创建失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建角色卡"
      description="name 是创建后不可修改的永久身份,也是角色目录名。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-3 pt-1">
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          name(永久身份)
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="角色全名" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          展示名(可空)
          <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="角色展示名" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          描述(可空)
          <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="一句话人设" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--ema-text-secondary)]">
          Persona Prompt
          <textarea
            className="min-h-28 w-full resize-y rounded-lg border border-[var(--ema-border)]
              bg-[var(--ema-surface-1)] px-3 py-2 text-sm text-[var(--ema-text-primary)]
              focus:outline-none focus:border-[var(--ema-primary)]"
            value={personaPrompt}
            onChange={e => setPersonaPrompt(e.target.value)}
            placeholder="角色人设提示词 提示词的质量直接影响角色的行为和表现"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!name.trim() || !personaPrompt.trim()}
            onClick={() => void handleCreate()}
          >
            创建
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
