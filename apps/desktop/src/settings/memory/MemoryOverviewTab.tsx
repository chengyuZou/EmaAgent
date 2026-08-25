import { useEffect, type JSX } from 'react';
import {
  Badge, Button, Callout, Card, Divider, Spinner, StatCard, Switch
} from '@ema-agent/ui';
import { useMemoryStore, type MemorySessionOverrides } from '../../stores/memory-store.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import { showToast } from '../../lib/toast.js';
import { MemoryHealthCard } from './MemoryHealthCard.js';
import { MemoryMaintenanceSettings } from './MemoryMaintenanceSettings.js';
import { NODE_TYPE_LABEL, NODE_TYPE_VARIANT, ITEM_KIND_LABEL, ITEM_KIND_VARIANT} from './memoryLabels.js';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';


export function OverviewTab(): JSX.Element {
  const stats        = useMemoryStore((s) => s.stats);
  const statsLoading = useMemoryStore((s) => s.statsLoading);
  const statsError   = useMemoryStore((s) => s.statsError);
  const activeTasks  = useMemoryStore((s) => s.activeTasks);
  const failedTasks  = useMemoryStore((s) => s.failedTasks);
  const viewedId     = useConversationStore((s) => s.viewedSessionId);
  const health       = useMemoryStore((s) => s.health);
  const sessionOverrides = useMemoryStore((s) =>
    viewedId ? s.sessionOverrides.get(viewedId as string) : undefined,
  );

  useEffect(() => {
    void useMemoryStore.getState().refreshStats();
    void useMemoryStore.getState().refreshHealth();
  }, []);

  useEffect(() => {
    if (viewedId) void useMemoryStore.getState().getSessionOverrides(viewedId);
  }, [viewedId]);

  function setOverride(key: keyof MemorySessionOverrides, value: boolean): void {
    if (!viewedId) return;
    const current = useMemoryStore.getState().sessionOverrides.get(viewedId as string) ?? {};
    void useMemoryStore.getState()
      .setSessionOverrides(viewedId, { ...current, [key]: value })
      .catch((err: Error) => showToast(`保存失败: ${err.message}`, { variant: 'danger' }));
  }

  if (statsLoading && !stats) {
    return <div className="flex justify-center py-16"><Spinner size="md" /></div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {statsError && (
        <Callout variant="danger">
          记忆统计刷新失败：{statsError}
        </Callout>
      )}

      {/* Stat cards */}
      {stats && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="节点" value={stats.nodes.total} sub={`avg 重要度 ${(stats.nodes.avgImportance * 100).toFixed(0)}%`} index={0} size="lg" decorate="ema-card-decorate--starfield" />
            <StatCard label="条目" value={stats.items.total} sub={`avg 重要度 ${(stats.items.avgImportance * 100).toFixed(0)}%`} index={1} size="lg" decorate="ema-card-decorate--starfield" />
            <StatCard label="边"   value={stats.edges.total} sub={`avg 引用 ${stats.edges.avgMentionCount.toFixed(1)}`} index={2} size="lg" decorate="ema-card-decorate--starfield" />
          </div>

          {/* By-type breakdown */}
          <div className="grid grid-cols-2 gap-3">
            {/* Nodes by type */}
            <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--starfield hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]">
              <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-2">节点类型分布</p>
              <div className="flex flex-col gap-1.5">
                {(Object.entries(stats.nodes.byType) as [MemoryNodeType, number][])
                  .filter(([, n]) => n > 0)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <div key={type} className="flex items-center gap-2">
                      <Badge variant={NODE_TYPE_VARIANT[type]}>{NODE_TYPE_LABEL[type]}</Badge>
                      <span className="text-xs font-semibold text-[var(--ema-text-secondary)] tabular-nums">{count}</span>
                    </div>
                  ))}
              </div>
            </Card>

            {/* Items by kind */}
            <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--starfield hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]">
              <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-2">条目类型分布</p>
              <div className="flex flex-col gap-1.5">
                {(Object.entries(stats.items.byKind) as [MemoryItemKind, number][])
                  .filter(([, n]) => n > 0)
                  .sort(([, a], [, b]) => b - a)
                  .map(([kind, count]) => (
                    <div key={kind} className="flex items-center gap-2">
                      <Badge variant={ITEM_KIND_VARIANT[kind]}>{ITEM_KIND_LABEL[kind]}</Badge>
                      <span className="text-xs font-semibold text-[var(--ema-text-secondary)] tabular-nums">{count}</span>
                    </div>
                  ))}
              </div>
            </Card>
          </div>

          {/* Index + embedding health */}
          <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--starfield hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]">
            <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-2">向量索引</p>
            <div className="flex gap-4 flex-wrap text-xs font-semibold text-[var(--ema-text-tertiary)]">
              <span>
                节点索引：
                {stats.index.nodes
                  ? <span className="font-semibold text-[var(--ema-text-primary)]"> {stats.index.nodes.size} 条 ({stats.index.nodes.backend})</span>
                  : <span className="opacity-40 font-semibold"> 未就绪</span>}
              </span>
              <span>
                条目索引：
                {stats.index.items
                  ? <span className="font-semibold text-[var(--ema-text-primary)]"> {stats.index.items.size} 条 ({stats.index.items.backend})</span>
                  : <span className="opacity-40 font-semibold"> 未就绪</span>}
              </span>
              {(stats.nodes.staleEmbedCount > 0 || stats.items.staleEmbedCount > 0) && (
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--ema-warning)]">
                  <span className="font-semibold i-mdi:alert-outline" aria-hidden />
                  过期向量：{stats.nodes.staleEmbedCount + stats.items.staleEmbedCount} 条
                </span>
              )}
            </div>
          </Card>
        </>
      )}

      {/* Active tasks */}
      {activeTasks.size > 0 && (
        <Callout variant="warn">
          <span className="font-semibold">后台任务进行中</span>
          <div className="mt-1 flex flex-col gap-0.5">
            {[...activeTasks.values()].map((t) => (
              <div key={t.taskId} className="text-xs text-[var(--ema-warning-text)]">
                {t.kind}{t.sessionId ? ` (${t.sessionId.slice(0, 8)}…)` : ''}
              </div>
            ))}
          </div>
        </Callout>
      )}

      {failedTasks.size > 0 && (
        <Callout variant="danger">
          <span className="font-semibold">后台记忆任务失败</span>
          <div className="mt-1 flex flex-col gap-1">
            {[...failedTasks.values()].map((failure) => (
              <div key={failure.taskId} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 break-words">
                  {failure.task?.kind ?? failure.taskId}：{failure.error}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => useMemoryStore.getState().clearTaskFailure(failure.taskId)}
                >
                  知道了
                </Button>
              </div>
            ))}
          </div>
        </Callout>
      )}

      {/* Per-session overrides */}
      {viewedId && (
        <>
          <Divider />
          <div>
            <p className="text-sm font-semibold text-[var(--ema-text-primary)] mb-0.5">当前会话记忆开关</p>
            <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-3">仅影响当前会话，不影响全局配置</p>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div>
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-2 uppercase tracking-wide">召回(读)</p>
                <div className="flex flex-col gap-2">
                  <OverrideSwitch label="L0 锚点召回" desc="全局身份图" checked={sessionOverrides?.layer0 ?? true}
                    onChange={(v) => setOverride('layer0', v)} />
                  <OverrideSwitch label="L1 关联召回" desc="会话摘要"  checked={sessionOverrides?.layer1 ?? true}
                    onChange={(v) => setOverride('layer1', v)} />
                  <OverrideSwitch label="L2 条目召回" desc="情节记录"  checked={sessionOverrides?.layer2 ?? true}
                    onChange={(v) => setOverride('layer2', v)} />
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-2 uppercase tracking-wide">写入(写)</p>
                <div className="flex flex-col gap-2">
                  <OverrideSwitch label="提取"   desc="turn 结束后写入待处理片段" checked={sessionOverrides?.extraction    ?? true}
                    onChange={(v) => setOverride('extraction', v)} />
                  <OverrideSwitch label="整合"   desc="合并 lazy 更新"            checked={sessionOverrides?.consolidation ?? true}
                    onChange={(v) => setOverride('consolidation', v)} />
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* 后台维护健康(M5) */}
      {health && (
        <>
          <Divider />
          <MemoryHealthCard health={health} />
        </>
      )}

      <Divider />
      <MemoryMaintenanceSettings />
    </div>
  );
}

export function OverrideSwitch({
  label, desc, checked, onChange,
}: {
  label: string; desc: string; checked: boolean; onChange(v: boolean): void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-[var(--ema-text-secondary)]">{label}</p>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-60">{desc}</p>
      </div>
      <Switch checked={checked} label={label} onCheckedChange={onChange} />
    </div>
  );
}