import {
  useState, useEffect, useRef, useCallback,
  type JSX, type CSSProperties,
} from 'react';
import {
  Button, CardButton, IconButton, Input, Spinner, Badge, Callout,
  EntityRow, StatCard as UIStatCard,
  ScrollArea, Skeleton, Dialog, Divider, Tabs, Progress,
} from '@ema-agent/ui';
import { useStorageStore }  from '../stores/storage-store.js';
import { useSessionStore }  from '../stores/session-store.js';
import { storageApi }       from '../api/storage.js';
import { tauriBridge }      from '../lib/tauri-bridge.js';
import { showToast }        from '../lib/toast.js';
import type { SessionId } from '@ema-agent/ids';
import type { SessionWire } from '../api/sessions.js';
import type {
  DataDirItem,
  StorageStatsWire,
  SessionDashboardWire,
} from '../api/storage.js';
import type {
  AudioEntryWire,
  SessionNoteEntryWire,
} from '@ema-agent/session';

// ── Animation helper ──────────────────────────────────────────────────────────
// Keeps node mounted for `delay` ms after `visible` goes false so the exit
// animation plays before React removes the element.

function useMountedAnim(visible: boolean, delay = 220): boolean {
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), delay);
    return () => clearTimeout(t);
  }, [visible, delay]);
  return mounted;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n === 0)           return '0 B';
  if (n < 1_024)         return `${n} B`;
  if (n < 1_048_576)     return `${(n / 1_024).toFixed(1)} KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(2)} MB`;
  return `${(n / 1_073_741_824).toFixed(2)} GB`;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  return `${(n / 1_000).toFixed(1)}k`;
}

function fmtDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: '2-digit', day: '2-digit',
  });
}

function fmtDateFull(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── AddDirDialog ──────────────────────────────────────────────────────────────

function AddDirDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  onAdded(): void;
}): JSX.Element {
  const [name,    setName]    = useState('');
  const [dirPath, setDirPath] = useState('');
  const [saving,  setSaving]  = useState(false);
  const store = useStorageStore();

  async function browsePath(): Promise<void> {
    const p = await tauriBridge.openFileDialog({ directory: true });
    if (p) setDirPath(p);
  }

  async function handleSave(): Promise<void> {
    if (!name.trim() || !dirPath.trim()) return;
    setSaving(true);
    try {
      await store.addDir({ name: name.trim(), path: dirPath.trim() });
      showToast('存储位置已添加', { variant: 'success' });
      setName(''); setDirPath('');
      onOpenChange(false);
      onAdded();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '添加失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加存储位置"
      description="注册一个已有或新建的数据目录。切换后需重启应用生效。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">名称</label>
          <Input
            placeholder="例如：工作区、个人"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">路径</label>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/storage"
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
              className="flex-1"
            />
            <IconButton
              icon="i-solar:folder-open-bold-duotone"
              label="浏览"
              onClick={() => void browsePath()}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!name.trim() || !dirPath.trim()}
            onClick={() => void handleSave()}
          >
            添加
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── MigrateDialog ─────────────────────────────────────────────────────────────

function MigrateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
}): JSX.Element {
  const [name,       setName]       = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [migrating,  setMigrating]  = useState(false);
  const store = useStorageStore();

  async function browsePath(): Promise<void> {
    const p = await tauriBridge.openFileDialog({ directory: true });
    if (p) setTargetPath(p);
  }

  async function handleMigrate(): Promise<void> {
    if (!name.trim() || !targetPath.trim()) return;
    setMigrating(true);
    try {
      const restart = await store.migrate({ name: name.trim(), targetPath: targetPath.trim() });
      if (restart) {
        showToast('迁移完成，请重启应用切换到新位置', { variant: 'success' });
      } else {
        showToast('迁移完成', { variant: 'success' });
      }
      setName(''); setTargetPath('');
      onOpenChange(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '迁移失败', { variant: 'danger' });
    } finally {
      setMigrating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="迁移当前存储"
      description="将当前数据库和文件完整复制到新路径，并自动切换。操作完成后需重启应用。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1">
        <Callout variant="warn" className="ema-slide-down">
          迁移过程中请勿退出应用。迁移完成后需手动重启以切换到新位置。
        </Callout>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">新位置名称</label>
          <Input
            placeholder="例如：迁移后"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">目标路径</label>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/new/location"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              className="flex-1"
            />
            <IconButton
              icon="i-solar:folder-open-bold-duotone"
              label="浏览"
              onClick={() => void browsePath()}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="danger"
            loading={migrating}
            disabled={!name.trim() || !targetPath.trim()}
            onClick={() => void handleMigrate()}
          >
            开始迁移
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── DataDirRow ────────────────────────────────────────────────────────────────

function DataDirRow({
  dir,
  index,
  onMigrateOpen,
}: {
  dir:           DataDirItem;
  index:         number;
  onMigrateOpen(): void;
}): JSX.Element {
  const [activating, setActivating] = useState(false);
  const [removing,   setRemoving]   = useState(false);
  const store = useStorageStore();

  async function handleActivate(): Promise<void> {
    setActivating(true);
    try {
      const restart = await store.activateDir(dir.name);
      if (restart) showToast('已切换，请重启应用生效', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', { variant: 'danger' });
    } finally {
      setActivating(false);
    }
  }

  async function handleRemove(): Promise<void> {
    setRemoving(true);
    try {
      await store.removeDir(dir.name);
      showToast('已移除存储位置（文件未删除）', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移除失败', { variant: 'danger' });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--storage"
      active={dir.isActive}
      index={index}
      className="group flex flex-col gap-1.5 px-3 py-2.5 transition-colors duration-[var(--ema-duration-base)]"
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-xs shrink-0 ${dir.isActive ? 'i-solar:check-circle-bold text-[var(--ema-primary)]' : 'i-solar:circle-line-duotone text-[var(--ema-text-tertiary)]'}`}
          aria-hidden
        />
        <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate flex-1">
          {dir.name}
        </span>
        {dir.isActive && (
          <Badge variant="success" className="ema-scale-in shrink-0">当前</Badge>
        )}
      </div>

      <p className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate pl-5" title={dir.path}>
        {dir.path}
      </p>

      <div className="flex items-center justify-between pl-5">
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          db {fmtBytes(dir.dataDbBytes)}
        </span>
        <div className={`flex items-center gap-1 transition-opacity duration-150
                          ${dir.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {dir.isActive ? (
            <Button
              variant="ghost"
              size="sm"
              icon="i-solar:transfer-horizontal-bold-duotone"
              onClick={onMigrateOpen}
            >
              迁移
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                loading={activating}
                onClick={() => void handleActivate()}
              >
                激活
              </Button>
              <IconButton
                icon="i-solar:trash-bin-trash-bold-duotone"
                label="移除"
                size="sm"
                loading={removing}
                onClick={() => void handleRemove()}
              />
            </>
          )}
        </div>
      </div>
    </EntityRow>
  );
}

// ── StatsPanel ────────────────────────────────────────────────────────────────
// Shown in the right pane when no session is selected.

function StatCard({
  label, value, sub, icon, index,
}: {
  label: string; value: string; sub?: string; icon: string; index: number;
}): JSX.Element {
  return (
    <UIStatCard label={label} value={value} sub={sub} icon={icon} index={index} size="md" decorate="ema-card-decorate--storage" />
  );
}

function StatsPanel({ stats, statsLoading }: {
  stats:        StorageStatsWire | null;
  statsLoading: boolean;
}): JSX.Element {
  if (statsLoading && !stats) {
    return (
      <div className="ema-slide-down grid grid-cols-2 gap-3 p-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="ema-slide-down flex flex-col items-center justify-center h-full gap-3 text-[var(--ema-text-tertiary)]">
        <span className="i-solar:database-bold-duotone text-4xl" aria-hidden />
        <p className="text-sm inline-flex items-center gap-1"><span className="i-mdi:arrow-left" aria-hidden />从左侧选择会话查看详情</p>
      </div>
    );
  }

  return (
    <div className="ema-slide-down flex flex-col gap-6 p-6">
      <div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">当前路径</p>
        <p className="text-sm font-mono text-[var(--ema-text-secondary)] selectable break-all">{stats.path}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard index={0} icon="i-solar:chat-round-bold-duotone"      label="会话"     value={String(stats.sessionCount)} />
        <StatCard index={1} icon="i-solar:refresh-circle-bold-duotone"  label="轮次"     value={String(stats.turnCount)} />
        <StatCard index={2} icon="i-solar:letter-bold-duotone"          label="消息"     value={String(stats.messageCount)} />
        <StatCard index={4} icon="i-solar:soundwave-bold-duotone"       label="音频轮次" value={String(stats.audioCount)}    sub={fmtDuration(stats.audioDurationMs)} />
        <StatCard index={5} icon="i-solar:magic-stick-3-bold-duotone"   label="子智能体执行" value={String(stats.agentRunCount)} />
      </div>

      <div className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--storage bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] p-4 shadow-[var(--ema-shadow-1)]"
           style={{ '--stagger-i': 6 } as CSSProperties}>
        <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-3">磁盘占用</p>
        <div className="flex flex-col gap-2">
          {([
            ['数据库',   stats.dataDbBytes],
            ['音频文件', stats.audioBytes],
            ['会话文件', stats.sessionsBytes],
          ] as [string, number][]).map(([label, bytes], i) => (
            <div key={label} className="ema-stagger-in" style={{ '--stagger-i': i + 7 } as CSSProperties}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-[var(--ema-text-tertiary)]">{label}</span>
                <span className="text-[var(--ema-text-secondary)] font-mono">{fmtBytes(bytes)}</span>
              </div>
              <Progress
                progress={stats.totalBytes > 0 ? Math.round((bytes / stats.totalBytes) * 100) : 0}
                height="h-1"
                barClass="bg-[var(--ema-primary)]"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-3 text-right">
          合计 {fmtBytes(stats.totalBytes)}
        </p>
      </div>
    </div>
  );
}

// ── SessionRow ────────────────────────────────────────────────────────────────

function SessionRow({
  session, selected, index, onClick,
}: {
  session:  SessionWire;
  selected: boolean;
  index:    number;
  onClick(): void;
}): JSX.Element {
  return (
    <CardButton
      selected={selected}
      padding="sm"
      onClick={onClick}
      className={`ema-stagger-in w-full rounded-xl font-normal ema-card-decorate ema-card-decorate--storage
        ${selected
          ? 'shadow-[var(--ema-shadow-1)] text-[var(--ema-text-primary)]'
          : 'text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)]'
        }`}
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <p className="text-sm font-semibold truncate leading-tight">
        {session.title || '未命名会话'}
      </p>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          {fmtDateShort(session.lastActivityAt)}
        </span>
        {session.pinned && (
          <span className="i-solar:pin-bold text-[10px] text-[var(--ema-primary)]" aria-hidden />
        )}
      </div>
    </CardButton>
  );
}

// ── Session dashboard sub-tabs ────────────────────────────────────────────────

function OverviewTab({ d }: { d: SessionDashboardWire }): JSX.Element {
  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: '轮次',     value: String(d.turnCount),
      sub: `Chat ${d.turnCounts.chat} · Work ${d.turnCounts.work} · Narrative Always ${d.turnCounts.narrativeAlways}` },
    { label: '消息',     value: String(d.messageCount) },
    { label: 'Token',    value: fmtTokens(d.totalInputTokens + d.totalOutputTokens),
      sub: `↑ ${fmtTokens(d.totalInputTokens)}  ↓ ${fmtTokens(d.totalOutputTokens)}` },
    { label: '音频',     value: String(d.audioTurnCount),
      sub: `${fmtDuration(d.audioTotalDurationMs)} · ${fmtBytes(d.audioTotalBytes)}` },
    { label: '附件',     value: String(d.attachmentCount), sub: fmtBytes(d.attachmentTotalBytes) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {cards.map((c, i) => (
        <div
          key={c.label}
          className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--storage bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] px-4 py-3
                     flex flex-col gap-0.5 shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as CSSProperties}
        >
          <span className="text-xs text-[var(--ema-text-tertiary)]">{c.label}</span>
          <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{c.value}</span>
          {c.sub && <span className="text-xs text-[var(--ema-text-tertiary)]">{c.sub}</span>}
        </div>
      ))}
    </div>
  );
}

function AudioTab({ entries }: { entries: AudioEntryWire[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <p className="ema-fade-in text-[var(--ema-text-tertiary)] text-sm py-8 text-center">
        暂无音频记录
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((e, i) => (
        <div
          key={e.turnId}
          className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--storage bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]
                     px-3 py-2.5 flex items-center gap-3 shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as CSSProperties}
        >
          <span className="i-solar:soundwave-bold-duotone text-base text-[var(--ema-text-tertiary)] shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[var(--ema-text-secondary)] font-mono truncate">{e.turnId.slice(-8)}</p>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              {fmtDuration(e.durationMs)} · {fmtBytes(e.byteSize)} · {e.segmentCount} 段
            </p>
          </div>
          <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">
            {e.mimeType.replace('audio/', '')}
          </span>
        </div>
      ))}
    </div>
  );
}

function MemoryTab({ notes }: { notes: SessionDashboardWire['notes'] }): JSX.Element {
  if (!notes || notes.entries.length === 0) {
    return (
      <p className="ema-fade-in text-[var(--ema-text-tertiary)] text-sm py-8 text-center">
        暂无 L1 记忆笔记
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="ema-slide-down text-xs text-[var(--ema-text-tertiary)] mb-1">
        {notes.entries.length} 条 · {fmtTokens(notes.tokensAtLastUpdate)} tokens
      </p>
      {(notes.entries as SessionNoteEntryWire[]).map((entry, i) => (
        <div
          key={i}
          className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--storage bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]
                     px-3 py-2.5 shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as CSSProperties}
        >
          <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">{entry.timestamp}</p>
          <p className="text-sm text-[var(--ema-text-primary)] whitespace-pre-wrap selectable">
            {entry.delta}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── SessionDashboard ──────────────────────────────────────────────────────────

function SessionDashboard({ session }: { session: SessionWire }): JSX.Element {
  const [tab,       setTab]       = useState('overview');
  const [exporting, setExporting] = useState(false);
  const sid   = session.id as SessionId;
  const store = useStorageStore();

  const dashboard = store.dashBySession.get(session.id);
  const loading   = store.isDashLoading(sid);
  const error     = store.getDashError(sid);

  useEffect(() => {
    if (!dashboard && !loading) {
      void store.loadDashboard(sid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const blob = await storageApi.exportSession(sid);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `ema-${(session.title || session.id).slice(0, 30)}-${session.id.slice(-6)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('导出完成', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', { variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  const tabs = dashboard ? [
    { value: 'overview',  label: '概览',                                  icon: 'i-solar:chart-2-bold-duotone',   content: <OverviewTab d={dashboard} /> },
    { value: 'audio',     label: `音频 (${dashboard.audioTurnCount})`,    icon: 'i-solar:soundwave-bold-duotone', content: <AudioTab entries={dashboard.audioEntries} /> },
    { value: 'memory',    label: '记忆',                                  icon: 'i-solar:leaf-bold-duotone',      content: <MemoryTab notes={dashboard.notes} /> },
  ] : [];

  return (
    <div className="ema-panel-in flex flex-col h-full">

      {/* Header */}
      <div className="flex-none px-6 py-4 border-b border-[var(--ema-border)]">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)] leading-snug truncate">
            {session.title || '未命名会话'}
          </h2>
          <Button
            variant="secondary" size="sm"
            icon="i-solar:download-minimalistic-bold-duotone"
            loading={exporting}
            onClick={() => void handleExport()}
            className="shrink-0"
          >
            导出 ZIP
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-0.5">
          <p className="text-xs text-[var(--ema-text-tertiary)]">
            <span className="i-solar:calendar-add-bold-duotone mr-1" aria-hidden />
            创建于 {fmtDateFull(session.createdAt)} · 活跃于 {fmtDateFull(session.lastActivityAt)}
          </p>
          {dashboard && (
            <p className="ema-slide-up text-xs text-[var(--ema-text-tertiary)]">
              {dashboard.turnCount} 轮 ·{' '}
              {fmtTokens(dashboard.totalInputTokens + dashboard.totalOutputTokens)} tokens ·{' '}
              {dashboard.audioTurnCount} 音频
            </p>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="ema-fade-in flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="ema-panel-in flex-1 flex flex-col items-center justify-center gap-3">
          <span className="i-solar:danger-circle-bold-duotone text-2xl text-[var(--ema-danger-text)]" aria-hidden />
          <p className="text-sm text-[var(--ema-text-secondary)]">{error}</p>
          <Button
            variant="ghost" size="sm"
            onClick={() => { store.clearDashboard(sid); void store.loadDashboard(sid); }}
          >
            重试
          </Button>
        </div>
      )}

      {/* Tabs + content */}
      {dashboard && !loading && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex-none px-6 pt-3">
            <Tabs value={tab} onChange={setTab} items={tabs} variant="pill" triggersOnly />
          </div>
          <ScrollArea className="flex-1 px-6 py-4">
            <div key={tab} className="ema-panel-in">
              {tabs.find((t) => t.value === tab)?.content}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

// ── EmptyRight ────────────────────────────────────────────────────────────────

function EmptyRight({ stats, statsLoading }: {
  stats: StorageStatsWire | null;
  statsLoading: boolean;
}): JSX.Element {
  return (
    <div className="ema-slide-in-right flex flex-col h-full overflow-y-auto">
      <StatsPanel stats={stats} statsLoading={statsLoading} />
    </div>
  );
}

// ── StorageTab ────────────────────────────────────────────────────────────────

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
