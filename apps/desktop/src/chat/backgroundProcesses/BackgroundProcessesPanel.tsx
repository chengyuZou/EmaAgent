// 后台进程面板:列表(运行/排队 + 已结束分组)到详情(事实行、有界输出、跟随尾部、终止)的标签内导航。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Badge, Button, IconButton, Spinner, type BadgeVariant } from '@ema-agent/ui';
import type { BackgroundProcessStatus, BackgroundProcessSummary } from '../../api/backgroundProcesses.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcessStore.js';
import { useConversationStore } from '../../stores/conversation-store.js';

const STATUS_LABEL: Record<BackgroundProcessStatus, string> = {
  queued:      '排队中',
  running:     '运行中',
  completed:   '已完成',
  failed:      '失败',
  timedOut:    '超时终止',
  stopped:     '已停止',
  interrupted: '已中断',
};

const STATUS_BADGE: Record<BackgroundProcessStatus, BadgeVariant> = {
  queued:      'neutral',
  running:     'primary',
  completed:   'success',
  failed:      'danger',
  timedOut:    'danger',
  stopped:     'neutral',
  interrupted: 'neutral',
};

const STATUS_ICON: Record<BackgroundProcessStatus, { icon: string; color: string }> = {
  queued:      { icon: 'i-lucide:clock',                       color: 'var(--ema-text-tertiary)' },
  running:     { icon: 'i-lucide:loader-circle animate-spin',  color: 'var(--ema-primary)' },
  completed:   { icon: 'i-lucide:circle-check',                color: 'var(--ema-success)' },
  failed:      { icon: 'i-lucide:circle-alert',                color: 'var(--ema-danger)' },
  timedOut:    { icon: 'i-lucide:timer-off',                   color: 'var(--ema-danger)' },
  stopped:     { icon: 'i-lucide:circle-stop',                 color: 'var(--ema-text-tertiary)' },
  interrupted: { icon: 'i-lucide:circle-x',                    color: 'var(--ema-text-tertiary)' },
};

function isLive(status: BackgroundProcessStatus): boolean {
  return status === 'queued' || status === 'running';
}

export interface BackgroundProcessesPanelProps {
  sessionId: string | null;
  className?: string;
}

export function BackgroundProcessesPanel({
  sessionId, className = '',
}: BackgroundProcessesPanelProps): JSX.Element {
  const list = useBackgroundProcessStore((s) =>
    sessionId ? s.listsBySession.get(sessionId) : undefined);
  const loadForSession = useBackgroundProcessStore((s) => s.loadForSession);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId) void loadForSession(sessionId);
  }, [sessionId, loadForSession]);

  const processes = useMemo(
    () => [...(list?.processes ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [list?.processes],
  );
  const live = processes.filter((p) => isLive(p.status));
  const terminal = processes.filter((p) => !isLive(p.status));
  const detailProcess = detailId
    ? processes.find((p) => (p.id as string) === detailId)
    : undefined;

  // 列表重拉后进程消失(Session 删除/重启恢复),回列表不展示假详情。
  useEffect(() => {
    if (detailId && list?.status === 'ready' && !detailProcess) setDetailId(null);
  }, [detailId, list?.status, detailProcess]);

  if (!sessionId) {
    return <EmptyHint icon="i-lucide:message-square-off" text="请先选择会话" />;
  }
  if (detailId && detailProcess) {
    return (
      <ProcessDetail
        sessionId={sessionId}
        process={detailProcess}
        className={className}
        onBack={() => setDetailId(null)}
      />
    );
  }

  if (list?.status === 'loading' && processes.length === 0) {
    return <div className="flex justify-center py-6"><Spinner size="sm" /></div>;
  }
  if (list?.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="i-lucide:cloud-alert text-2xl text-[var(--ema-danger)]" aria-hidden />
        <p className="text-xs text-[var(--ema-danger)]">{list.error}</p>
        <Button variant="secondary" size="sm" onClick={() => void loadForSession(sessionId)}>
          重新加载
        </Button>
      </div>
    );
  }
  if (processes.length === 0) {
    return <EmptyHint icon="i-lucide:square-terminal" text="当前会话没有后台进程" />;
  }

  return (
    <div className={`flex flex-col gap-1 overflow-y-auto p-2 ${className}`}>
      {live.length > 0 && (
        <>
          <SectionLabel>进行中</SectionLabel>
          {live.map((p) => (
            <ProcessRow key={p.id as string} process={p} onOpen={() => setDetailId(p.id as string)} />
          ))}
        </>
      )}
      {terminal.length > 0 && (
        <>
          <SectionLabel>{`已结束 · ${terminal.length}`}</SectionLabel>
          {terminal.map((p) => (
            <ProcessRow key={p.id as string} process={p} onOpen={() => setDetailId(p.id as string)} />
          ))}
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 pt-0.5 pb-0.5 text-xs font-medium tracking-wider uppercase text-[var(--ema-text-tertiary)]">
      {children}
    </div>
  );
}

function ProcessRow({
  process, onOpen,
}: {
  process: BackgroundProcessSummary;
  onOpen(): void;
}): JSX.Element {
  const meta = STATUS_ICON[process.status];
  return (
    <button
      className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all bg-[var(--ema-surface-1)] border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]"
      onClick={onOpen}
    >
      <span className={`${meta.icon} shrink-0 text-base`} style={{ color: meta.color }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-[var(--ema-text-primary)]" title={process.command}>
          {process.description ?? process.command}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-[var(--ema-text-tertiary)]">
          {STATUS_LABEL[process.status]}
          {process.exitCode !== undefined ? ` · exit ${process.exitCode}` : ''}
          {' · '}{formatDuration(process.durationMs)}
        </p>
      </div>
      <span className="i-lucide:chevron-right shrink-0 text-xs text-[var(--ema-text-tertiary)]" aria-hidden />
    </button>
  );
}

// ── 详情 ──────────────────────────────────────────────────────────────────────

function ProcessDetail({
  sessionId, process, className, onBack,
}: {
  sessionId: string;
  process: BackgroundProcessSummary;
  className: string;
  onBack(): void;
}): JSX.Element {
  const readOutput = useBackgroundProcessStore((s) => s.readOutput);
  const setFollowTail = useBackgroundProcessStore((s) => s.setFollowTail);
  const stop = useBackgroundProcessStore((s) => s.stop);
  const output = useBackgroundProcessStore((s) => s.outputsById.get(process.id as string));
  const scrollToTurn = useConversationStore((s) => s.scrollToTurn);
  const [stopping, setStopping] = useState(false);

  const processId = process.id as string;
  const live = isLive(process.status);

  useEffect(() => {
    void readOutput(sessionId, processId);
    return () => setFollowTail(sessionId, processId, false);
  }, [sessionId, processId, readOutput, setFollowTail]);

  const meta = STATUS_ICON[process.status];
  const followTail = output?.followTail ?? false;

  const handleStop = async (): Promise<void> => {
    setStopping(true);
    try {
      await stop(sessionId, processId);
    } catch (error: unknown) {
      showToast(error instanceof Error ? `终止失败：${error.message}` : '终止失败', { variant: 'danger' });
    } finally {
      setStopping(false);
    }
  };

  const handleReveal = async (): Promise<void> => {
    try {
      await tauriBridge.revealInFolder(process.outputDir);
    } catch {
      showToast('系统未能打开日志目录', { variant: 'danger' });
    }
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--ema-border)] px-2 py-1.5">
        <Button variant="ghost" size="sm" className="px-1.5 text-[var(--ema-text-tertiary)]" onClick={onBack}>
          <span className="i-lucide:arrow-left text-sm" aria-hidden />
        </Button>
        <span className={`${meta.icon} shrink-0 text-sm`} style={{ color: meta.color }} aria-hidden />
        <span className="truncate text-xs font-medium text-[var(--ema-text-primary)]" title={process.command}>
          {process.description ?? process.command}
        </span>
        <Badge variant={STATUS_BADGE[process.status]} dot={process.status === 'running'}>
          {STATUS_LABEL[process.status]}
        </Badge>
      </div>

      {/* 事实行:命令/目录/退出码/时长/输出量,全部来自持久记录。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--ema-border)] px-3 py-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
        <span className="max-w-full truncate font-mono" title={process.command}>{process.command}</span>
        <span className="max-w-64 truncate" title={process.cwd}>{process.cwd}</span>
        {process.exitCode !== undefined && <span>exit {process.exitCode}</span>}
        <span>{formatDuration(process.durationMs)}</span>
        <span>
          输出 {formatBytes(process.stdoutBytes + process.stderrBytes)}
          {process.outputTruncated ? '(已截断)' : ''}
        </span>
        {process.originTurnId && (
          <button
            className="text-[var(--ema-primary)] hover:text-[var(--ema-primary-hover)] transition-colors"
            onClick={() => scrollToTurn(process.originTurnId as string)}
            title="滚动到启动该进程的对话轮次"
          >
            来源轮次
          </button>
        )}
      </div>
      {process.terminationReason && (
        <p className="shrink-0 truncate border-b border-[var(--ema-border)] px-3 py-1 text-xs text-[var(--ema-warning-text)]">
          {process.terminationReason}
        </p>
      )}

      {/* 输出:只渲染有界缓冲,上游更多时如实提示并给文件管理器入口。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 py-1">
          <span className="text-[11px] text-[var(--ema-text-tertiary)]">
            输出(最多显示 64KB)
          </span>
          <span className="flex-1" />
          {live && (
            <Button
              variant="ghost"
              size="sm"
              className={`px-2 text-[11px] ${followTail ? 'text-[var(--ema-primary)]' : 'text-[var(--ema-text-tertiary)]'}`}
              onClick={() => setFollowTail(sessionId, processId, !followTail)}
            >
              {followTail ? '停止跟随' : '跟随尾部'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="px-2 text-[11px] text-[var(--ema-text-tertiary)]" onClick={() => void handleReveal()}>
            在文件管理器中显示
          </Button>
          {live && (
            <IconButton
              variant="danger"
              size="sm"
              icon="i-lucide:circle-stop"
              label="终止进程"
              loading={stopping}
              onClick={() => void handleStop()}
            />
          )}
        </div>
        {(output?.hasMore || process.outputTruncated) && (
          <p className="shrink-0 px-3 pb-1 text-[10px] text-[var(--ema-text-tertiary)]">
            日志过大,只显示部分内容;完整日志见文件。
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {output === undefined ? (
            <div className="flex justify-center py-4"><Spinner size="sm" /></div>
          ) : (
            <>
              <OutputStream label="stdout" text={output.stdout} />
              <OutputStream label="stderr" text={output.stderr} danger />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputStream({
  label, text, danger = false,
}: {
  label: string;
  text: string;
  danger?: boolean;
}): JSX.Element | null {
  if (!text.trim()) return null;
  return (
    <div className="py-1">
      <div className={`text-[10px] font-medium ${danger ? 'text-[var(--ema-danger-text)]' : 'text-[var(--ema-text-tertiary)]'}`}>
        {label}
      </div>
      <pre className="selectable whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--ema-text-secondary)]">
        {text}
      </pre>
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <span className={`${icon} text-3xl opacity-25 text-[var(--ema-primary)]`} aria-hidden />
      <p className="text-xs text-[var(--ema-text-tertiary)]">{text}</p>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
