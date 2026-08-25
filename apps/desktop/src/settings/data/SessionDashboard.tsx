// 会话维度面板:左侧会话行,右侧概览/音频/记忆三个子页与 ZIP 导出。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import {
  Button, CardButton, ScrollArea, Spinner, Tabs,
} from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage-store.js';
import { storageApi } from '../../api/storage.js';
import { showToast } from '../../lib/toast.js';

import type { SessionWire } from '../../api/sessions.js';
import type { SessionDashboardWire } from '../../api/storage.js';
import type { AudioEntryWire, SessionNoteEntryWire } from '@ema-agent/session';
import { fmtBytes, fmtDateFull, fmtDateShort, fmtDuration, fmtTokens } from './storageFormat.js';

export function SessionRow({
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

function NotesTab({ notes }: { notes: SessionDashboardWire['notes'] }): JSX.Element {
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

export function SessionDashboard({ session }: { session: SessionWire }): JSX.Element {
  const [tab,       setTab]       = useState('overview');
  const [exporting, setExporting] = useState(false);
  const sid   = session.id;
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
      const { blob, filename } = await storageApi.exportSession(sid);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      // 文件名以后端 Content-Disposition 为准,只有旧后端才回退本地拼接。
      a.download = filename
        ?? `ema-${(session.title || session.id).slice(0, 30)}-${session.id.slice(-6)}.zip`;
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
    { value: 'memory',    label: '记忆',                                  icon: 'i-solar:leaf-bold-duotone',      content: <NotesTab notes={dashboard.notes} /> },
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
