// 展示本机磁盘与系统事件连接状态，并支持刷新与复制报告。
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">系统诊断</h1>
          <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
            查看本机存储与事件连接状态，便于定位运行异常。
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
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="系统事件订阅"
              value={snapshot.systemEvents.subscribers}
              sub="当前活跃连接"
              icon="i-solar:translation-2-bold-duotone"
              index={0}
            />
            <StatCard
              label="磁盘"
              value={snapshot.system.disks.length}
              sub="后端当前可见"
              icon="i-solar:diskette-bold-duotone"
              index={1}
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

          <Callout variant="info">
            复制内容包含本机数据目录与磁盘路径；发送给他人前请先确认其中没有隐私信息。
          </Callout>
        </>
      )}
    </div>
  );
}
