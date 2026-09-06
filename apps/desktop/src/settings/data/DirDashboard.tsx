// L2:单个存储库内部——库统计卡 + session 卡(导出按活动库开放) + 顶部导入。
import { useEffect, useRef, useState, type JSX } from 'react';
import { Badge, IconButton, Skeleton } from '@ema-agent/ui';
import { useStorageStore, type DirSessionItem } from '../../stores/storage.js';
import { sessionsApi } from '../../api/sessions.js';
import { showToast } from '../../lib/toast.js';
import { fmtBytes, fmtDateShort, fmtDuration } from './storageFormat.js';

export function DirDashboard({
  dirName, onBack, onOpenSession,
}: {
  dirName: string;
  onBack(): void;
  onOpenSession(sessionId: string, sessionTitle: string): void;
}): JSX.Element {
  const store = useStorageStore();
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const isActive = store.activeName === dirName;
  const stats = store.statsByDir.get(dirName);
  const sessions = store.sessionsByDir.get(dirName);
  const loading = store.dirBrowseLoading.has(dirName);

  useEffect(() => {
    void store.loadDirStats(dirName, true);
    void store.loadDirSessions(dirName);
  }, [dirName]);

  async function handleImport(file: File): Promise<void> {
    setImporting(true);
    try {
      const result = await sessionsApi.importSession(file);
      await store.loadDirSessions(dirName, true);
      showToast(
        result.warnings.length > 0
          ? `会话已导入,但有 ${result.warnings.length} 项内容缺失`
          : '会话导入成功',
        { variant: result.warnings.length > 0 ? 'warning' : 'success' },
      );
    } catch (err) {
      showToast(err instanceof Error ? `导入失败:${err.message}` : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  async function handleExport(session: DirSessionItem): Promise<void> {
    setExporting(session.id);
    try {
      const response = await sessionsApi.exportSession(session.id);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${session.title || 'session'}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? `导出失败:${err.message}` : '导出失败', { variant: 'danger' });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--ema-border)] shrink-0">
        <button
          className="flex items-center gap-1 text-sm text-[var(--ema-text-secondary)]
            hover:text-[var(--ema-text-primary)] transition-colors"
          onClick={onBack}
        >
          <span className="i-mdi:arrow-left" aria-hidden />存储库
        </button>
        <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{dirName}</span>
        {isActive && <Badge variant="primary">活动</Badge>}
        <div className="flex-1" />
        {isActive && (
          <>
            <IconButton
              icon="i-solar:upload-minimalistic-bold-duotone"
              label="导入会话到当前活动库"
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
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        {stats && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard label="会话" value={stats.sessionCount} />
            <StatCard label="消息" value={stats.messageCount} />
            <StatCard label="附件" value={stats.attachmentCount} sub={fmtBytes(stats.attachmentTotalBytes)} />
            <StatCard label="音频轮次" value={stats.audioCount} sub={fmtDuration(stats.audioDurationMs)} />
          </div>
        )}

        <div className="flex flex-col gap-2">
          {loading && !sessions && [0, 1, 2].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}
          {sessions && sessions.length === 0 && (
            <p className="text-xs text-[var(--ema-text-tertiary)] text-center py-10">这个存储库还没有会话</p>
          )}
          {sessions?.map((session, i) => (
            <div
              key={session.id}
              className="ema-stagger-in group flex items-center gap-3 rounded-xl border border-[var(--ema-border)]
                bg-[var(--ema-surface-2)] px-4 py-3 cursor-pointer transition-all
                hover:bg-[var(--ema-surface-3)] hover:border-[var(--ema-border-strong)]"
              style={{ '--stagger-i': i } as React.CSSProperties}
              onClick={() => onOpenSession(session.id, session.title || '未命名会话')}
            >
              <span className="i-solar:chat-round-bold-duotone text-[var(--ema-primary)]" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">
                  {session.title || '未命名会话'}
                </p>
                <p className="text-xs text-[var(--ema-text-tertiary)]">
                  {fmtDateShort(session.last_activity_at)}
                </p>
              </div>
              {isActive && (
                <div onClick={e => e.stopPropagation()}>
                  <IconButton
                    icon="i-solar:download-minimalistic-bold-duotone"
                    label={`导出 ${session.title || '会话'}`}
                    size="sm"
                    loading={exporting === session.id}
                    onClick={() => void handleExport(session)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] p-4">
      <div className="text-xl font-bold text-[var(--ema-text-primary)]">{value}</div>
      <div className="text-xs text-[var(--ema-text-secondary)] mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5">{sub}</div>}
    </div>
  );
}
