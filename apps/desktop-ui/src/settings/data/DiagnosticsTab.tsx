// 展示本机磁盘、系统事件连接和 Hook 执行诊断，并支持刷新与复制报告。
import { useEffect, type JSX } from 'react';
import { Badge, Button, Callout, Spinner, StatCard } from '@ema-agent/ui';
import {
  serializeDiagnosticsSnapshot,
  useDiagnosticsStore,
  type DiagnosticsSnapshot,
} from '../../stores/diagnostics-store.js';
import { showToast } from '../../lib/toast.js';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function HookTraceList({
  title,
  traces,
  emptyText,
}: {
  title: string;
  traces: DiagnosticsSnapshot['hooks']['failures'];
  emptyText: string;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">{title}</h3>
      {traces.length === 0 ? (
        <p className="text-xs text-[var(--ema-text-tertiary)] py-3">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {traces.slice(0, 10).map((trace) => (
            <div
              key={`${trace.invocationId}-${trace.handlerName}`}
              className="ema-glass-weak rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Badge variant={trace.result === 'error' ? 'danger' : 'neutral'}>{trace.result}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--ema-text-primary)]">
                  {trace.handlerName}
                </span>
                <span className="shrink-0 font-mono text-xs text-[var(--ema-text-tertiary)]">
                  {trace.durationMs.toFixed(1)} ms
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-[var(--ema-text-tertiary)]">
                {trace.event} · Session {trace.sessionId.slice(-8)} · Turn {trace.turnId.slice(-8)}
              </p>
              {trace.reason && (
                <p className="mt-1 break-words text-xs text-[var(--ema-danger-text)]">{trace.reason}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DiagnosticsTab(): JSX.Element {
  const snapshot = useDiagnosticsStore((state) => state.snapshot);
  const status = useDiagnosticsStore((state) => state.status);
  const error = useDiagnosticsStore((state) => state.error);

  useEffect(() => {
    void useDiagnosticsStore.getState().load().catch(() => {});
  }, []);

  async function copyReport(): Promise<void> {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(serializeDiagnosticsSnapshot(snapshot));
      showToast('诊断信息已复制', { variant: 'success' });
    } catch (copyError) {
      showToast(
        copyError instanceof Error ? `复制失败：${copyError.message}` : '复制诊断信息失败',
        { variant: 'danger' },
      );
    }
  }

  const loadingWithoutSnapshot = status === 'loading' && !snapshot;
  const hookFailures = snapshot?.hooks.failures.length ?? 0;
  const slowestDuration = snapshot?.hooks.slowest[0]?.durationMs ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">系统诊断</h1>
          <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
            查看本机存储、事件连接和 Hook 执行状态，便于定位运行异常。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon="i-solar:copy-bold-duotone"
            disabled={!snapshot}
            onClick={() => void copyReport()}
          >
            复制诊断信息
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="i-solar:refresh-bold-duotone"
            loading={status === 'loading'}
            onClick={() => void useDiagnosticsStore.getState().load(true).catch(() => {})}
          >
            刷新
          </Button>
        </div>
      </header>

      {error && (
        <Callout variant={snapshot ? 'warn' : 'danger'} title="诊断数据加载失败">
          {snapshot ? `当前保留上一次快照：${error}` : error}
        </Callout>
      )}

      {loadingWithoutSnapshot && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--ema-text-tertiary)]">
          <Spinner size="sm" /> 正在读取诊断信息…
        </div>
      )}

      {!loadingWithoutSnapshot && !snapshot && status === 'error' && (
        <div className="flex justify-center py-6">
          <Button
            variant="secondary"
            onClick={() => void useDiagnosticsStore.getState().load(true).catch(() => {})}
          >
            重试
          </Button>
        </div>
      )}

      {snapshot && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Hook 记录"
              value={snapshot.hooks.totalCaptured}
              sub={`${hookFailures} 项失败`}
              icon="i-solar:programming-bold-duotone"
              index={0}
            />
            <StatCard
              label="最慢 Hook"
              value={`${slowestDuration.toFixed(1)} ms`}
              sub={snapshot.hooks.slowest[0]?.handlerName ?? '暂无记录'}
              icon="i-solar:clock-circle-bold-duotone"
              index={1}
            />
            <StatCard
              label="系统事件订阅"
              value={snapshot.systemEvents.subscribers}
              sub="当前活跃连接"
              icon="i-solar:translation-2-bold-duotone"
              index={2}
            />
            <StatCard
              label="磁盘"
              value={snapshot.system.disks.length}
              sub="后端当前可见"
              icon="i-solar:diskette-bold-duotone"
              index={3}
            />
          </div>

          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">本机存储</h2>
              <p className="mt-1 break-all font-mono text-xs text-[var(--ema-text-tertiary)]">
                数据目录：{snapshot.system.dataDir}
              </p>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {snapshot.system.disks.map((disk) => {
                const used = Math.max(0, disk.total - disk.free);
                const usage = disk.total > 0 ? Math.round((used / disk.total) * 100) : 0;
                return (
                  <div
                    key={`${disk.mount}-${disk.label}`}
                    className="ema-glass-weak rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">
                        {disk.label || disk.mount}
                      </span>
                      <Badge variant={usage >= 90 ? 'danger' : usage >= 75 ? 'warn' : 'neutral'}>
                        {usage}% 已用
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-[var(--ema-text-tertiary)]">{disk.mount}</p>
                    <p className="mt-2 text-xs text-[var(--ema-text-secondary)]">
                      可用 {formatBytes(disk.free)} / 共 {formatBytes(disk.total)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <HookTraceList title="Hook 失败" traces={snapshot.hooks.failures} emptyText="当前没有 Hook 失败记录。" />
            <HookTraceList title="最慢 Hook" traces={snapshot.hooks.slowest} emptyText="当前没有 Hook 执行记录。" />
          </div>

          <Callout variant="info">
            复制内容包含本机数据目录、磁盘路径、Session/Turn 标识和 Hook 错误原因；发送给他人前请先确认其中没有隐私信息。
          </Callout>
        </>
      )}
    </div>
  );
}
