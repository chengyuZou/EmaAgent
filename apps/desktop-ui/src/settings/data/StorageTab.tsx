// 存储位置设置主装配:左列存储位置与会话列表,右窗格总体统计或会话面板。
// 子部件各自成文件,这里只取数与拼块。
import {
  useState, useEffect, useRef,
  type JSX,
} from 'react';
import {
  Callout, Divider, IconButton, Input, ScrollArea, Skeleton,
} from '@ema-agent/ui';
import { useStorageStore }  from '../../stores/storage-store.js';
import { useSessionStore }  from '../../stores/session-store.js';
import { storageApi }       from '../../api/storage.js';
import { showToast }        from '../../lib/toast.js';
import { useMountedAnim } from './storageFormat.js';
import { AddDirDialog, MigrateDialog } from './StorageDirDialogs.js';
import { DataDirRow } from './DataDirRow.js';
import { EmptyRight } from './StorageStatsPanel.js';
import { SessionDashboard, SessionRow } from './SessionDashboard.js';

export function StorageTab(): JSX.Element {
  const [search,      setSearch]      = useState('');
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [addOpen,     setAddOpen]     = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [importing,   setImporting]   = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const store  = useStorageStore();
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoading = useSessionStore((s) => s.loading);

  // Flatten all sessions (pinned + groups + recent + archived)
  const allSessions = [
    ...sessions.pinned,
    ...sessions.byGroup.flatMap((g) => g.sessions),
    ...sessions.recent,
    ...sessions.archived,
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

  const filtered = search.trim()
    ? allSessions.filter((s) =>
        (s.title || '未命名会话').toLowerCase().includes(search.trim().toLowerCase()),
      )
    : allSessions;

  const selectedSession = selectedId
    ? allSessions.find((s) => s.id === selectedId) ?? null
    : null;

  // Mounted state for right-pane panels (drives exit animations)
  const showDetail = !!selectedSession;
  const detailMounted = useMountedAnim(showDetail);
  const emptyMounted  = useMountedAnim(!showDetail);

  useEffect(() => {
    void store.loadDirs();
    void store.loadStats();
    void useSessionStore.getState().loadSessions();
  }, []);

  async function handleImport(file: File): Promise<void> {
    setImporting(true);
    try {
      const result = await storageApi.importSession(file);
      await useSessionStore.getState().loadSessions();
      showToast('会话导入成功', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex h-full">

      {/* ── Left column ─────────────────────────────────────────── */}
      <div className="flex flex-col w-64 flex-none border-r border-[var(--ema-border)]">

        {/* DataDir section */}
        <div className="flex-none px-3 pt-4 pb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ema-text-tertiary)]">
              存储位置
            </span>
            <IconButton
              icon="i-solar:add-circle-bold-duotone"
              label="添加存储位置"
              size="sm"
              onClick={() => setAddOpen(true)}
            />
          </div>

          {store.dirsLoading && store.dirs.length === 0 && (
            <div className="ema-slide-down flex flex-col gap-1.5">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-20 rounded-xl" />
              ))}
            </div>
          )}

          {store.dirsError && (
            <Callout variant="danger" className="ema-slide-down text-xs">
              {store.dirsError}
            </Callout>
          )}

          <div className="flex flex-col gap-1.5">
            {store.dirs.map((dir, i) => (
              <DataDirRow
                key={dir.name}
                dir={dir}
                index={i}
                onMigrateOpen={() => setMigrateOpen(true)}
              />
            ))}
          </div>
        </div>

        <Divider className="mx-3" />

        {/* Session list section */}
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ema-text-tertiary)]">
            历史会话
          </span>
          <>
            <IconButton
              icon="i-solar:upload-minimalistic-bold-duotone"
              label="导入会话"
              size="sm"
              loading={importing}
              onClick={() => importRef.current?.click()}
            />
            <input
              ref={importRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
                e.target.value = '';
              }}
            />
          </>
        </div>

        <div className="px-3 pb-2">
          <Input
            inputSize="sm"
            placeholder="搜索会话..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full"
          />
        </div>

        <ScrollArea className="flex-1 px-2 pb-2">
          {sessionsLoading && allSessions.length === 0 && (
            <div className="ema-slide-down flex flex-col gap-1 p-1">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          )}
          {!sessionsLoading && filtered.length === 0 && (
            <p className="ema-fade-in text-xs text-[var(--ema-text-tertiary)] text-center py-6">
              {search ? '没有匹配的会话' : '暂无会话'}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {filtered.map((s, i) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={s.id === selectedId}
                index={i}
                onClick={() => setSelectedId((prev) => (prev === s.id ? null : s.id))}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* ── Right pane ──────────────────────────────────────────── */}
      <div className="relative flex-1 min-w-0 overflow-hidden">

        {emptyMounted && (
          <div className={`absolute inset-0 ${showDetail ? 'ema-fade-out pointer-events-none' : 'ema-slide-in-right'}`}>
            <EmptyRight stats={store.stats} statsLoading={store.statsLoading} />
          </div>
        )}

        {detailMounted && selectedSession && (
          <div className={`absolute inset-0 ${showDetail ? 'ema-panel-in' : 'ema-fade-out pointer-events-none'}`}>
            <SessionDashboard key={selectedSession.id} session={selectedSession} />
          </div>
        )}
      </div>

      {/* ── Dialogs ─────────────────────────────────────────────── */}
      <AddDirDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => void store.loadStats()}
      />
      <MigrateDialog open={migrateOpen} onOpenChange={setMigrateOpen} />
    </div>
  );
}
