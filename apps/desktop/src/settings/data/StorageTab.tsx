// 存储域主装配:L1 存储库卡 → L2 库内会话与统计 → L3 Session 原生消息流。
// 删除走 DeleteDirDialog 双档;添加/迁移沿用既有对话框。
import {
  useEffect, useRef, useState,
  type JSX,
} from 'react';
import {
  Badge, Callout, IconButton, Skeleton, Spinner,
} from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage.js';
import { sessionsApi } from '../../api/sessions.js';
import { showToast } from '../../lib/toast.js';
import { AddDirDialog, MigrateDialog } from './StorageDirDialogs.js';
import { DeleteDirDialog } from './DeleteDirDialog.js';
import { DirDashboard } from './DirDashboard.js';
import { SessionMessagesView } from './SessionMessagesView.js';
import type { DataDirItem } from '../../api/workspaces.js';

export type StorageView =
  | { level: 'libraries' }
  | { level: 'dir'; dirName: string }
  | { level: 'session'; dirName: string; sessionId: string; sessionTitle: string };

export function StorageTab(): JSX.Element {
  const [view, setView] = useState<StorageView>({ level: 'libraries' });
  const [addOpen, setAddOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [deleting, setDeleting] = useState<DataDirItem | null>(null);
  const store = useStorageStore();

  useEffect(() => {
    void store.loadDirs();
  }, []);

  // L1 卡片的统计:每个已注册库各拉一次(活动库与只读非活动库同通道)。
  useEffect(() => {
    for (const dir of store.dirs) void store.loadDirStats(dir.name);
  }, [store.dirs.length]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {view.level === 'libraries' && (
        <LibrariesView
          onOpen={dirName => setView({ level: 'dir', dirName })}
          onAdd={() => setAddOpen(true)}
          onMigrate={() => setMigrateOpen(true)}
          onDelete={dir => setDeleting(dir)}
        />
      )}

      {view.level === 'dir' && (
        <DirDashboard
          dirName={view.dirName}
          onBack={() => setView({ level: 'libraries' })}
          onOpenSession={(sessionId, sessionTitle) =>
            setView({ level: 'session', dirName: view.dirName, sessionId, sessionTitle })}
        />
      )}

      {view.level === 'session' && (
        <SessionMessagesView
          dirName={view.dirName}
          sessionId={view.sessionId}
          sessionTitle={view.sessionTitle}
          onBack={() => setView({ level: 'dir', dirName: view.dirName })}
        />
      )}

      <AddDirDialog open={addOpen} onOpenChange={setAddOpen} onAdded={() => void store.loadDirs()} />
      <MigrateDialog open={migrateOpen} onOpenChange={setMigrateOpen} />
      <DeleteDirDialog
        dir={deleting}
        open={deleting !== null}
        onOpenChange={open => { if (!open) setDeleting(null); }}
      />
    </div>
  );
}

// ── L1:存储库大卡 ────────────────────────────────────────────────────────────

function LibrariesView({
  onOpen, onAdd, onMigrate, onDelete,
}: {
  onOpen(dirName: string): void;
  onAdd(): void;
  onMigrate(): void;
  onDelete(dir: DataDirItem): void;
}): JSX.Element {
  const store = useStorageStore();
  const [activating, setActivating] = useState<string | null>(null);

  async function handleActivate(name: string): Promise<void> {
    setActivating(name);
    try {
      const restart = await store.activateDir(name);
      if (restart) showToast('已切换,请重启应用生效', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', { variant: 'danger' });
    } finally {
      setActivating(null);
    }
  }

  if (store.dirsLoading && store.dirs.length === 0) {
    return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  }
  if (store.dirsError) {
    return <Callout variant="danger" className="m-6">{store.dirsError}</Callout>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {store.dirs.map((dir, i) => {
          const isActive = dir.name === store.activeName;
          const stats = store.statsByDir.get(dir.name);
          return (
            <div
              key={dir.name}
              className="ema-stagger-in group relative flex flex-col gap-2 rounded-2xl border border-[var(--ema-border)]
                bg-[var(--ema-surface-2)] p-5 cursor-pointer transition-all duration-[var(--ema-duration-base)]
                hover:bg-[var(--ema-surface-3)] hover:border-[var(--ema-border-strong)] hover:-translate-y-0.5 hover:shadow-[var(--ema-shadow-soft)]"
              style={{ '--stagger-i': i } as React.CSSProperties}
              onClick={() => onOpen(dir.name)}
            >
              <div className="flex items-center gap-2 pr-8">
                <span className="i-solar:database-bold-duotone text-lg text-[var(--ema-primary)]" aria-hidden />
                <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{dir.name}</span>
                {isActive && <Badge variant="primary">活动</Badge>}
              </div>
              <p className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate">{dir.path}</p>
              <div className="flex items-center gap-4 mt-1 text-sm text-[var(--ema-text-secondary)]">
                {stats ? (
                  <>
                    <span>{stats.sessionCount} 会话</span>
                    <span>{stats.messageCount} 消息</span>
                    <span>{stats.attachmentCount} 附件</span>
                  </>
                ) : (
                  <Skeleton className="h-4 w-32" />
                )}
              </div>
              <div className="flex items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
                {!isActive && (
                  <button
                    className="text-xs px-2.5 py-1 rounded-lg border border-[var(--ema-border)]
                      text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)]
                      hover:border-[var(--ema-primary)] transition-colors"
                    disabled={activating === dir.name}
                    onClick={() => void handleActivate(dir.name)}
                  >
                    {activating === dir.name ? '切换中…' : '设为活动'}
                  </button>
                )}
                {isActive && (
                  <button
                    className="text-xs px-2.5 py-1 rounded-lg border border-[var(--ema-border)]
                      text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)]
                      hover:border-[var(--ema-border-strong)] transition-colors"
                    onClick={onMigrate}
                  >
                    迁移
                  </button>
                )}
              </div>
              <div className="absolute top-3 right-3" onClick={e => e.stopPropagation()}>
                <IconButton
                  icon="i-solar:trash-bin-trash-bold-duotone"
                  label={`删除存储库 ${dir.name}`}
                  size="sm"
                  onClick={() => onDelete(dir)}
                />
              </div>
            </div>
          );
        })}

        <button
          className="ema-stagger-in flex flex-col items-center justify-center gap-2 rounded-2xl
            border border-dashed border-[var(--ema-border-strong)] p-5 min-h-32
            text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]
            hover:border-[var(--ema-primary)] transition-colors"
          style={{ '--stagger-i': store.dirs.length } as React.CSSProperties}
          onClick={onAdd}
        >
          <span className="i-solar:add-circle-bold-duotone text-2xl" aria-hidden />
          <span className="text-sm">添加存储位置</span>
        </button>
      </div>
    </div>
  );
}
