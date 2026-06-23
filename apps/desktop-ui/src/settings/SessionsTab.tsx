import { useState, useEffect, useRef, type JSX } from 'react';
import {
  Button, IconButton, Input, Progress,
  Spinner, Badge, Tabs, ScrollArea, Skeleton,
} from '@ema-agent/ui';
import { useSessionStore }       from '../stores/session-store.js';
import { useSessionDetailStore } from '../stores/session-detail-store.js';
import { sessionsApi }           from '../api/sessions.js';
import { systemApi }             from '../api/system.js';
import { showToast }             from '../lib/toast.js';
import type { SessionId }        from '@ema-agent/contracts';
import type { SessionWire }      from '../api/sessions.js';
import type {
  SessionDashboardWire,
  ArtifactSummaryWire,
  AudioEntryWire,
  SessionNoteEntryWire,
} from '../api/sessions.js';
import type { SystemInfoWire }   from '../api/system.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: '2-digit', day: '2-digit',
  });
}

// ── Storage overview ──────────────────────────────────────────────────────────

function StorageBar({ info }: { info: SystemInfoWire | null }): JSX.Element {
  if (!info) {
    return (
      <div className="flex gap-4 px-6 py-4 border-b border-[var(--ema-border)]">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 flex-1 rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <div className="ema-slide-down flex flex-wrap items-center gap-5 px-6 py-4 border-b border-[var(--ema-border)]">
      {info.disks.map((d) => {
        const usedPct    = Math.round(((d.total - d.free) / d.total) * 100);
        const isCritical = usedPct >= 90;
        const isWarn     = usedPct >= 75;
        return (
          <div key={d.mount} className="flex items-center gap-3 min-w-44">
            <span
              className="i-solar:hard-drive-bold-duotone text-xl shrink-0 text-[var(--ema-text-tertiary)]"
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between mb-1 gap-2">
                <span className="text-xs font-medium text-[var(--ema-text-secondary)] truncate">
                  {d.label || d.mount}
                </span>
                <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">{d.mount}</span>
              </div>
              <Progress
                progress={usedPct}
                height="h-1.5"
                barClass={
                  isCritical ? 'bg-[var(--ema-danger)]'
                  : isWarn    ? 'bg-[var(--ema-warning)]'
                  : 'bg-[var(--ema-primary)]'
                }
              />
              <p className="text-xs text-[var(--ema-text-tertiary)] mt-1">
                {fmtBytes(d.free)} 可用 / {fmtBytes(d.total)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Session list row ──────────────────────────────────────────────────────────

function SessionRow({
  session,
  selected,
  index,
  onClick,
}: {
  session:  SessionWire;
  selected: boolean;
  index:    number;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ema-stagger-in w-full text-left px-4 py-3 rounded-xl
        transition-colors duration-[var(--ema-duration-base)]
        ${selected
          ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]'
          : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]'
        }`}
      style={{ '--stagger-i': index } as React.CSSProperties}
    >
      <p className="text-sm font-medium truncate leading-tight">
        {session.title || '未命名会话'}
      </p>
      <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
        {fmtDateShort(session.lastActivityAt)}
        {/* TODO: 总字节数 — 需对 artifact/audio 路径逐一 fs.statSync 加总 */}
      </p>
    </button>
  );
}

// ── Detail tab contents ───────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="ema-glass-weak bg-[var(--ema-surface-1)] rounded-xl px-4 py-3 flex flex-col gap-0.5 shadow-[var(--ema-shadow-1)]">
      <span className="text-xs text-[var(--ema-text-tertiary)]">{label}</span>
      <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{value}</span>
      {sub && <span className="text-xs text-[var(--ema-text-tertiary)]">{sub}</span>}
    </div>
  );
}

function OverviewTab({ d }: { d: SessionDashboardWire }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <StatCard
        label="轮次"
        value={String(d.turnCount)}
        sub={`聊 ${d.modeCounts.chat} · 叙 ${d.modeCounts.narrative} · Agent ${d.modeCounts.agent}`}
      />
      <StatCard label="Branch"   value={String(d.branchCount)} />
      <StatCard label="消息"     value={String(d.messageCount)} />
      <StatCard
        label="Token 用量"
        value={fmtTokens(d.totalInputTokens + d.totalOutputTokens)}
        sub={`↑ ${fmtTokens(d.totalInputTokens)}  ↓ ${fmtTokens(d.totalOutputTokens)}`}
      />
      <StatCard label="Artifact"  value={String(d.artifactCount)}   sub={fmtBytes(d.artifactTotalBytes)} />
      <StatCard label="音频轮次"  value={String(d.audioTurnCount)}  sub={fmtBytes(d.audioTotalBytes)} />
      <StatCard label="附件"      value={String(d.attachmentCount)} sub={fmtBytes(d.attachmentTotalBytes)} />
      <StatCard label="音频时长"  value={fmtDuration(d.audioTotalDurationMs)} />
    </div>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: ArtifactSummaryWire[] }): JSX.Element {
  if (artifacts.length === 0) {
    return <p className="text-[var(--ema-text-tertiary)] text-sm py-8 text-center">暂无 Artifact</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {artifacts.map((a, i) => (
        <div
          key={a.id}
          className="ema-stagger-in ema-glass-weak bg-[var(--ema-surface-1)] rounded-xl px-3 py-2.5
                     flex items-center gap-3 shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as React.CSSProperties}
        >
          <span className="i-solar:document-bold text-base text-[var(--ema-text-tertiary)] shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-[var(--ema-text-primary)] truncate">{a.title || '(untitled)'}</p>
            <p className="text-xs text-[var(--ema-text-tertiary)]">{a.type} · {fmtBytes(a.byteSize)}</p>
          </div>
          {a.appliedAt  && <Badge variant="success">已应用</Badge>}
          {a.rejectedAt && <Badge variant="warn">已拒绝</Badge>}
        </div>
      ))}
    </div>
  );
}

function AudioTab({ entries }: { entries: AudioEntryWire[] }): JSX.Element {
  if (entries.length === 0) {
    return <p className="text-[var(--ema-text-tertiary)] text-sm py-8 text-center">暂无音频记录</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((e, i) => (
        <div
          key={e.turnId}
          className="ema-stagger-in ema-glass-weak bg-[var(--ema-surface-1)] rounded-xl px-3 py-2.5
                     flex items-center gap-3 shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as React.CSSProperties}
        >
          <span className="i-solar:soundwave-bold-duotone text-base text-[var(--ema-text-tertiary)] shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[var(--ema-text-secondary)] font-mono truncate">{e.turnId.slice(-8)}</p>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              {fmtDuration(e.durationMs)} · {fmtBytes(e.byteSize)} · {e.segmentCount} 段
            </p>
          </div>
          <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">{e.mimeType.replace('audio/', '')}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryTab({ notes }: { notes: SessionDashboardWire['notes'] }): JSX.Element {
  if (!notes || notes.entries.length === 0) {
    return <p className="text-[var(--ema-text-tertiary)] text-sm py-8 text-center">暂无 L1 记忆笔记</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">
        {notes.entries.length} 条 · {fmtTokens(notes.tokensAtLastUpdate)} tokens
      </p>
      {(notes.entries as SessionNoteEntryWire[]).map((entry, i) => (
        <div
          key={i}
          className="ema-stagger-in ema-glass-weak bg-[var(--ema-surface-1)] rounded-xl px-3 py-2.5
                     shadow-[var(--ema-shadow-1)]"
          style={{ '--stagger-i': i } as React.CSSProperties}
        >
          <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">{entry.timestamp}</p>
          <p className="text-sm text-[var(--ema-text-primary)] whitespace-pre-wrap">{entry.delta}</p>
        </div>
      ))}
    </div>
  );
}

// ── Right pane: detail ────────────────────────────────────────────────────────

function SessionDetail({
  session,
  dataDir,
}: {
  session: SessionWire;
  dataDir: string;
}): JSX.Element {
  const [tab, setTab]             = useState('overview');
  const [exporting, setExporting] = useState(false);
  const sid       = session.id as unknown as SessionId;
  const store     = useSessionDetailStore();
  const dashboard = store.dashboardBySession.get(session.id);
  const loading   = store.isLoading(sid);
  const error     = store.getError(sid);

  useEffect(() => {
    if (!dashboard && !loading) {
      void store.loadDashboard(sid);
    }
  }, [session.id]);

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const blob = await sessionsApi.exportSession(session.id as SessionId);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `ema-${(session.title || session.id).slice(0, 30)}-${session.id.slice(-6)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', { variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  const tabs = dashboard
    ? [
        { value: 'overview',  label: '概览',                                   icon: 'i-solar:chart-2-bold-duotone',     content: <OverviewTab d={dashboard} /> },
        { value: 'artifacts', label: `Artifact (${dashboard.artifactCount})`,  icon: 'i-solar:document-bold-duotone',    content: <ArtifactsTab artifacts={dashboard.artifacts} /> },
        { value: 'audio',     label: `音频 (${dashboard.audioTurnCount})`,     icon: 'i-solar:soundwave-bold-duotone',   content: <AudioTab entries={dashboard.audioEntries} /> },
        { value: 'memory',    label: '记忆',                                   icon: 'i-solar:leaf-bold-duotone',        content: <MemoryTab notes={dashboard.notes} /> },
      ]
    : [];

  return (
    // ema-panel-in: scale-in entrance each time a new session is selected
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

        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
            <span className="i-solar:calendar-add-bold-duotone text-sm" aria-hidden />
            <span>创建于 {fmtDate(session.createdAt)}</span>
            <span className="mx-1 text-[var(--ema-border-strong)]">·</span>
            <span>活跃于 {fmtDate(session.lastActivityAt)}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
            <span className="i-solar:folder-open-bold-duotone text-sm shrink-0" aria-hidden />
            <span className="selectable font-mono truncate" title={dataDir}>{dataDir}</span>
          </div>
          {dashboard && (
            <div className="ema-slide-up flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--ema-text-tertiary)] mt-0.5">
              <span>{dashboard.turnCount} 轮</span>
              <span className="text-[var(--ema-border-strong)]">·</span>
              <span>{dashboard.branchCount} Branch</span>
              <span className="text-[var(--ema-border-strong)]">·</span>
              <span>{fmtTokens(dashboard.totalInputTokens + dashboard.totalOutputTokens)} tokens</span>
              <span className="text-[var(--ema-border-strong)]">·</span>
              <span>{dashboard.artifactCount} Artifact</span>
              <span className="text-[var(--ema-border-strong)]">·</span>
              <span>{dashboard.audioTurnCount} 音频</span>
            </div>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
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
            onClick={() => { store.clearSession(sid); void store.loadDashboard(sid); }}
          >
            重试
          </Button>
        </div>
      )}

      {/* Tabs + content */}
      {dashboard && !loading && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex-none px-6 pt-3 pb-0">
            <Tabs value={tab} onChange={setTab} items={tabs} variant="pill" />
          </div>
          <ScrollArea className="flex-1 px-6 py-4">
            {tabs.find((t) => t.value === tab)?.content}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyDetail(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--ema-text-tertiary)]">
      <span className="i-solar:history-bold-duotone text-4xl" aria-hidden />
      <p className="text-sm">← 从左侧选择一个会话</p>
    </div>
  );
}

// ── SessionsTab ───────────────────────────────────────────────────────────────

export function SessionsTab(): JSX.Element {
  const [systemInfo, setSystemInfo] = useState<SystemInfoWire | null>(null);
  const [search,     setSearch]     = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing,  setImporting]  = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const { sessions, loading: sessionsLoading } = useSessionStore();
  const allSessions = [
    ...sessions.pinned,
    ...sessions.recent,
    ...sessions.byGroup.flatMap((g) => g.sessions),
    ...sessions.archived,
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

  useEffect(() => {
    void useSessionStore.getState().loadSessions();
    void systemApi.getInfo().then(setSystemInfo).catch(() => {});
  }, []);

  const filtered = search.trim()
    ? allSessions.filter((s) =>
        (s.title || '未命名会话').toLowerCase().includes(search.trim().toLowerCase()),
      )
    : allSessions;

  const selected = selectedId ? allSessions.find((s) => s.id === selectedId) ?? null : null;

  async function handleImport(file: File): Promise<void> {
    setImporting(true);
    try {
      await sessionsApi.importSession(file);
      await useSessionStore.getState().loadSessions();
      showToast('会话导入成功');
    } catch (err) {
      showToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* Storage overview */}
      <StorageBar info={systemInfo} />

      {/* Two-column body */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left column ── */}
        <div className="flex flex-col w-72 flex-none border-r border-[var(--ema-border)]">

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ema-border)]">
            <span className="text-sm font-medium text-[var(--ema-text-secondary)]">历史会话</span>
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
          </div>

          {/* Search */}
          <div className="px-3 py-2 border-b border-[var(--ema-border)]">
            <Input
              inputSize="sm"
              placeholder="搜索会话..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full"
            />
          </div>

          {/* List */}
          <ScrollArea className="flex-1">
            {sessionsLoading && (
              <div className="flex flex-col gap-1 p-3">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-xl" />
                ))}
              </div>
            )}
            {!sessionsLoading && filtered.length === 0 && (
              <p className="text-xs text-[var(--ema-text-tertiary)] text-center py-8">
                {search ? '没有匹配的会话' : '暂无会话'}
              </p>
            )}
            {!sessionsLoading && (
              <div className="flex flex-col gap-0.5 p-2">
                {filtered.map((s, i) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    selected={s.id === selectedId}
                    index={i}
                    onClick={() => setSelectedId(s.id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* ── Right column ── */}
        <div className="flex-1 min-w-0">
          {selected
            ? <SessionDetail key={selected.id} session={selected} dataDir={systemInfo?.dataDir ?? ''} />
            : <EmptyDetail />
          }
        </div>

      </div>
    </div>
  );
}
