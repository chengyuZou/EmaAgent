// 知识库注册表管理:新建、激活、重命名与取消注册;移除不删除磁盘文件。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import {
  Badge, Button, Callout, Dialog, EmptyState, EntityRow, IconButton, Input, Spinner,
} from '@ema-agent/ui';
import { useKbStore, type KbLibraryWire } from '../../stores/kb-store.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

function LibraryRow({ lib, onActivate, onRename, onDelete }: {
  lib:        KbLibraryWire;
  onActivate(): void;
  onRename(name: string): void;
  onDelete(): void;
}): JSX.Element {
  const [editing,   setEditing]   = useState(false);
  const [nameInput, setNameInput] = useState(lib.name);
  const [deleting,  setDeleting]  = useState(false);

  async function commitRename(): Promise<void> {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === lib.name) { setEditing(false); setNameInput(lib.name); return; }
    onRename(trimmed);
    setEditing(false);
  }

  async function handleDelete(): Promise<void> {
    if (lib.isActive) { showToast('无法删除当前激活的知识库', { variant: 'warning' }); return; }
    setDeleting(true);
    onDelete();
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--starfield"
      active={lib.isActive}
      className="group ema-slide-up flex items-center gap-3 px-3 py-2.5"
    >
      <span
        className={`shrink-0 text-lg ${lib.isActive ? 'i-solar:database-bold text-[var(--ema-primary)]' : 'i-solar:database-linear text-[var(--ema-text-tertiary)]'}`}
        aria-hidden
      />

      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            className="text-sm h-7"
            value={nameInput}
            autoFocus
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') { setEditing(false); setNameInput(lib.name); }
            }}
          />
        ) : (
          <>
            <p className="text-sm text-[var(--ema-text-primary)] truncate">{lib.name}</p>
            <p className="text-[10px] text-[var(--ema-text-tertiary)] font-mono truncate mt-0.5">{lib.path}</p>
          </>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0 transition-opacity duration-150
                      ${lib.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}">
        {lib.isActive ? (
          <Badge variant="success" className="text-xs">激活中</Badge>
        ) : (
          <Button variant="ghost" size="sm" className="text-xs" onClick={onActivate}>
            激活
          </Button>
        )}
        <IconButton
          variant="default" size="sm" label="重命名"
          icon="i-solar:pen-bold"
          onClick={() => { setEditing(true); setNameInput(lib.name); }}
        />
        <IconButton
          variant="default" size="sm" label="移除"
          icon={deleting ? 'i-solar:refresh-bold animate-spin' : 'i-solar:trash-bin-2-bold'}
          disabled={deleting || lib.isActive}
          onClick={() => void handleDelete()}
        />
      </div>
    </EntityRow>
  );
}

function CreateLibDialog({ onCreated }: { onCreated(): void }): JSX.Element {
  const [open,    setOpen]    = useState(false);
  const [name,    setName]    = useState('');
  const [kbPath,  setKbPath]  = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  function handleOpenChange(v: boolean): void {
    setOpen(v);
    if (!v) { setName(''); setKbPath(''); setError(null); }
  }

  async function pickFolder(): Promise<void> {
    const picked = await tauriBridge.openFileDialog({ directory: true });
    if (picked) setKbPath(picked);
  }

  async function handleCreate(): Promise<void> {
    const n = name.trim();
    const p = kbPath.trim();
    if (!n) { setError('请输入知识库名称'); return; }
    if (!p) { setError('请选择文件夹'); return; }
    setSaving(true); setError(null);
    const lib = await useKbStore.getState().createLib(n, p);
    setSaving(false);
    if (!lib) {
      setError(useKbStore.getState().libsError ?? '创建失败');
      return;
    }
    showToast(`已创建「${lib.name}」`, { variant: 'success' });
    handleOpenChange(false);
    onCreated();
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <span className="i-solar:add-circle-bold mr-1" aria-hidden />新建知识库
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange} title="新建知识库">
        <div className="flex flex-col gap-4 ema-slide-up">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--ema-text-tertiary)]">名称</label>
            <Input
              placeholder="我的知识库"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--ema-text-tertiary)]">存储文件夹</label>
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-xs"
                placeholder="选择一个空文件夹…"
                value={kbPath}
                onChange={(e) => setKbPath(e.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>浏览…</Button>
            </div>
            <p className="text-[11px] text-[var(--ema-text-tertiary)]">
              知识库的 SQLite 文件和向量文件将存储在此文件夹内，推荐选择一个新的空文件夹。
            </p>
          </div>

          {error && (
            <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>取消</Button>
            <Button
              variant="primary" size="sm"
              disabled={saving || !name.trim() || !kbPath.trim()}
              onClick={() => void handleCreate()}
            >
              {saving ? <><Spinner size="sm" className="mr-1.5" />创建中…</> : '创建'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function LibraryManager(): JSX.Element {
  const libs       = useKbStore((s) => s.libs);
  const loading    = useKbStore((s) => s.libsLoading);
  const error      = useKbStore((s) => s.libsError);

  useEffect(() => { void useKbStore.getState().loadLibs(); }, []);

  return (
    <section className="flex flex-col gap-3 ema-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">
          知识库
          {libs.length > 0 && (
            <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">({libs.length})</span>
          )}
        </h2>
        <CreateLibDialog onCreated={() => void useKbStore.getState().loadLibs()} />
      </div>

      {error && <Callout variant="danger" className="text-xs ema-fade-in">{error}</Callout>}

      {loading && libs.length === 0 ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : libs.length === 0 ? (
        <EmptyState icon="i-solar:database-bold" title="暂无知识库，点击「新建知识库」开始" animate size="sm" className="h-20" />
      ) : (
        <div className="flex flex-col gap-2">
          {libs.map((lib, i) => (
            <div key={lib.id} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
              <LibraryRow
                lib={lib}
                onActivate={() => void useKbStore.getState().activateLib(lib.id).then(() => showToast(`已切换到「${lib.name}」`, { variant: 'success' }))}
                onRename={(name) => void useKbStore.getState().renameLib(lib.id, name).then(() => showToast('已重命名', { variant: 'success' }))}
                onDelete={() => void useKbStore.getState().deleteLib(lib.id).then(() => showToast('已移除', { variant: 'success' }))}
              />
            </div>
          ))}
        </div>
      )}

      <Callout variant="info" className="text-xs leading-relaxed ema-slide-up">
        移除知识库只是从列表取消注册，<b>不会删除磁盘文件</b>。需要彻底清除请手动删除对应文件夹。
      </Callout>
    </section>
  );
}
