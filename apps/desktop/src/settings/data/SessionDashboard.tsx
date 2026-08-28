// 会话维度面板:左侧会话行,右侧统计概览与 ZIP 导出。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import {
  Button, CardButton, ScrollArea, Spinner,
} from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage.js';
import { sessionsApi, type Session } from '../../api/sessions.js';
import { showToast } from '../../lib/toast.js';

import type { SessionStats } from '../../api/system.js';
import { fmtBytes, fmtDateFull, fmtDateShort, fmtDuration, fmtTokens } from './storageFormat.js';

export function SessionRow({
  session, selected, index, onClick,
}: {
  session:  Session;
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

// ── Session stats overview ────────────────────────────────────────────────────

function OverviewCards({ d }: { d: SessionStats }): JSX.Element {
  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: '轮次',     value: String(d.turnCount),
      sub: `Chat ${d.chatTurns} · Work ${d.workTurns} · Narrative Always ${d.narrativeAlwaysTurns}` },
    { label: '消息',     value: String(d.messageCount) },
    { label: 'Token',    value: fmtTokens(d.totalInputTokens + d.totalOutputTokens),
      sub: `↑ ${fmtTokens(d.totalInputTokens)}  ↓ ${fmtTokens(d.totalOutputTokens)}` },
    { label: '音频',     value: String(d.audioTurnCount),
      sub: `${fmtDuration(d.audioTotalDurationMs)} · ${fmtBytes(d.audioTotalBytes)}` },
    { label: '附件',     value: String(d.attachmentCount), sub: fmtBytes(d.attachmentTotalBytes) },
    { label: '任务',     value: String(d.taskCount),
      sub: `子智能体 ${d.agentRunCount} · 工具执行 ${d.toolExecutionCount}` },
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

// ── SessionDashboard ──────────────────────────────────────────────────────────

export function SessionDashboard({ session }: { session: Session }): JSX.Element {
  const [exporting, setExporting] = useState(false);
  const sid   = session.id;
  const store = useStorageStore();

  const stats = store.dashBySession.get(session.id) as SessionStats | undefined;
  const loading   = store.isDashLoading(sid);
  const error     = store.getDashError(sid);

  useEffect(() => {
    if (!stats && !loading) {
      void store.loadDashboard(sid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const res = await sessionsApi.exportSession(sid);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      const filename = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      // 文件名以后端 Content-Disposition 为准,缺失时回退本地拼接。
      a.download = filename
        ? decodeURIComponent(filename)
        : `ema-${(session.title || session.id).slice(0, 30)}-${session.id.slice(-6)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('导出完成', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', { variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

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
          {stats && (
            <p className="ema-slide-up text-xs text-[var(--ema-text-tertiary)]">
              {stats.turnCount} 轮 ·{' '}
              {fmtTokens(stats.totalInputTokens + stats.totalOutputTokens)} tokens ·{' '}
              {stats.audioTurnCount} 音频
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

      {/* Stats */}
      {stats && !loading && (
        <ScrollArea className="flex-1 px-6 py-4">
          <div className="ema-panel-in">
            <OverviewCards d={stats} />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
