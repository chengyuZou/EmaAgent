import { useEffect, useState, type JSX } from 'react';
import { Dialog, Tabs, Badge, Spinner, Button } from '@ema-agent/ui';
import { useSessionDetailStore } from '../stores/session-detail-store.js';
import { sessionsApi } from '../api/sessions.js';
import { showToast } from '../lib/toast.js';
import type { SessionId } from '@ema-agent/contracts';
import type {
  SessionDashboardWire,
  ArtifactSummaryWire,
  AudioEntryWire,
  SessionNoteEntryWire,
} from '../api/sessions.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="ema-glass-weak rounded-lg px-4 py-3 flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-lg font-semibold text-neutral-100 truncate">{value}</span>
      {sub && <span className="text-xs text-neutral-500">{sub}</span>}
    </div>
  );
}

function OverviewTab({ d }: { d: SessionDashboardWire }): JSX.Element {
  const totalBytes = d.artifactTotalBytes + d.audioTotalBytes + d.attachmentTotalBytes;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatCard label="总大小"      value={fmtBytes(totalBytes)} />
        <StatCard label="轮次"        value={String(d.turnCount)}
          sub={`聊 ${d.modeCounts.chat} · 叙 ${d.modeCounts.narrative} · Agent ${d.modeCounts.agent}`} />
        <StatCard label="消息"        value={String(d.messageCount)} />
        <StatCard label="Token 用量"  value={fmtTokens(d.totalInputTokens + d.totalOutputTokens)}
          sub={`↑ ${fmtTokens(d.totalInputTokens)}  ↓ ${fmtTokens(d.totalOutputTokens)}`} />
        <StatCard label="Artifact"    value={String(d.artifactCount)}   sub={fmtBytes(d.artifactTotalBytes)} />
        <StatCard label="音频轮次"    value={String(d.audioTurnCount)}  sub={fmtBytes(d.audioTotalBytes)} />
        <StatCard label="附件"        value={String(d.attachmentCount)} sub={fmtBytes(d.attachmentTotalBytes)} />
        <StatCard label="音频时长"    value={fmtDuration(d.audioTotalDurationMs)} />
      </div>
    </div>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: ArtifactSummaryWire[] }): JSX.Element {
  if (artifacts.length === 0) {
    return <p className="text-neutral-500 text-sm py-4 text-center">暂无 Artifact</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {artifacts.map((a, i) => (
        <div
          key={a.id}
          className="ema-stagger-in ema-glass-weak rounded-lg px-3 py-2 flex items-center gap-3"
          style={{ '--stagger-i': i } as React.CSSProperties}
        >
          <span className="i-mdi:file-outline text-base text-neutral-400 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-neutral-200 truncate">{a.title || '(untitled)'}</p>
            <p className="text-xs text-neutral-500">{a.type} · {fmtBytes(a.byteSize)}</p>
          </div>
          {a.appliedAt && (
            <Badge variant="success">已应用</Badge>
          )}
          {a.rejectedAt && (
            <Badge variant="warn">已拒绝</Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function AudioTab({ entries }: { entries: AudioEntryWire[] }): JSX.Element {
  if (entries.length === 0) {
    return <p className="text-neutral-500 text-sm py-4 text-center">暂无音频记录</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {entries.map((e, i) => (
        <div
          key={e.turnId}
          className="ema-stagger-in ema-glass-weak rounded-lg px-3 py-2 flex items-center gap-3"
          style={{ '--stagger-i': i } as React.CSSProperties}
        >
          <span className="i-mdi:waveform text-base text-neutral-400 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-neutral-400 font-mono truncate">{e.turnId.slice(-8)}</p>
            <p className="text-xs text-neutral-500">
              {fmtDuration(e.durationMs)} · {fmtBytes(e.byteSize)} · {e.segmentCount}段
            </p>
          </div>
          <span className="text-xs text-neutral-500 shrink-0">{e.mimeType.replace('audio/', '')}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryTab({ notes }: { notes: SessionDashboardWire['notes'] }): JSX.Element {
  if (!notes || notes.entries.length === 0) {
    return <p className="text-neutral-500 text-sm py-4 text-center">暂无 L1 记忆笔记</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-neutral-500">
        {notes.entries.length} 条 · {fmtTokens(notes.tokensAtLastUpdate)} tokens
      </p>
      <div className="flex flex-col gap-1.5">
        {(notes.entries as SessionNoteEntryWire[]).map((entry, i) => (
          <div
            key={i}
            className="ema-stagger-in ema-glass-weak rounded-lg px-3 py-2"
            style={{ '--stagger-i': i } as React.CSSProperties}
          >
            <p className="text-xs text-neutral-500 mb-1">{entry.timestamp}</p>
            <p className="text-sm text-neutral-200 whitespace-pre-wrap">{entry.delta}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface SessionDetailPanelProps {
  sessionId: SessionId;
  sessionTitle?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function SessionDetailPanel({
  sessionId, sessionTitle, open, onOpenChange,
}: SessionDetailPanelProps): JSX.Element {
  const [tab, setTab] = useState('overview');
  const [exporting, setExporting] = useState(false);

  const store     = useSessionDetailStore();
  const dashboard = store.dashboardBySession.get(sessionId);
  const loading   = store.isLoading(sessionId);
  const error     = store.getError(sessionId);

  useEffect(() => {
    if (open && !dashboard && !loading) {
      void store.loadDashboard(sessionId);
    }
  }, [open, sessionId, dashboard, loading]);

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await sessionsApi.exportSession(sessionId);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `ema-${(sessionTitle ?? sessionId).slice(0, 30)}-${sessionId.slice(-6)}.zip`;
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
        {
          value:   'overview',
          label:   '概览',
          icon:    'i-mdi:chart-box-outline',
          content: <OverviewTab d={dashboard} />,
        },
        {
          value:   'artifacts',
          label:   `Artifact (${dashboard.artifactCount})`,
          icon:    'i-mdi:file-document-multiple-outline',
          content: <ArtifactsTab artifacts={dashboard.artifacts} />,
        },
        {
          value:   'audio',
          label:   `音频 (${dashboard.audioTurnCount})`,
          icon:    'i-mdi:waveform',
          content: <AudioTab entries={dashboard.audioEntries} />,
        },
        {
          value:   'memory',
          label:   `记忆`,
          icon:    'i-mdi:brain',
          content: <MemoryTab notes={dashboard.notes} />,
        },
      ]
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={sessionTitle ? `${sessionTitle}` : '会话详情'}
      description="会话数据概览 · 导出 / 导入"
      widthClass="max-w-2xl"
    >
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center gap-3 py-12">
          <span className="i-mdi:alert-circle-outline text-2xl text-danger-400" aria-hidden />
          <p className="text-sm text-neutral-400">{error}</p>
          <Button
            variant="ghost" size="sm"
            onClick={() => { store.clearSession(sessionId); void store.loadDashboard(sessionId); }}
          >
            重试
          </Button>
        </div>
      )}

      {dashboard && !loading && (
        <div className="flex flex-col gap-4">
          <Tabs
            value={tab}
            onChange={setTab}
            items={tabs}
            variant="pill"
          />

          <div className="flex justify-end pt-2 border-t border-neutral-800/60">
            <Button
              variant="secondary"
              size="sm"
              loading={exporting}
              icon="i-mdi:download-outline"
              onClick={() => void handleExport()}
            >
              导出 ZIP
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
