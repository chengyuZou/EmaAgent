import { useState, useEffect, useCallback, type CSSProperties, type JSX } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog, Divider, Field,
  Input, Progress, ScrollArea, Select, Spinner, StatCard, EmptyState, Switch, Tabs, Tooltip,
} from '@ema-agent/ui';
import { useMemoryStore, type MemorySessionOverrides } from '../../stores/memory-store.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import { memoryApi, type MemoryNodeRow, type MemoryItemRow } from '../../api/memory.js';
import { showToast } from '../../lib/toast.js';
import { MemoryHealthCard } from './MemoryHealthCard.js';
import { MemoryMaintenanceSettings } from './MemoryMaintenanceSettings.js';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';

// ── Label maps ────────────────────────────────────────────────────────────────

const NODE_TYPE_LABEL: Record<MemoryNodeType, string> = {
  user_fact:    '事实',
  entity:       '实体',
  event:        '事件',
  emotion:      '情感',
  preference:   '偏好',
  relationship: '关系',
};

const NODE_TYPE_VARIANT: Record<MemoryNodeType, 'primary' | 'neutral' | 'warn' | 'violet' | 'success'> = {
  user_fact:    'primary',
  entity:       'neutral',
  event:        'warn',
  emotion:      'success',
  preference:   'violet',
  relationship: 'neutral',
};

const ITEM_KIND_LABEL: Record<MemoryItemKind, string> = {
  user:      '用户',
  feedback:  '反馈',
  project:   '项目',
  reference: '参考',
};

const ITEM_KIND_VARIANT: Record<MemoryItemKind, 'primary' | 'neutral' | 'warn' | 'violet'> = {
  user:      'primary',
  feedback:  'warn',
  project:   'violet',
  reference: 'neutral',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)          return '刚刚';
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

function importanceBarClass(importance: number): string {
  if (importance < 0.3) return 'bg-[var(--ema-text-tertiary)]';
  if (importance < 0.7) return 'bg-[var(--ema-primary)]';
  return 'bg-[var(--ema-success)]';
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab(): JSX.Element {
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

function OverrideSwitch({
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

// ── Nodes tab ─────────────────────────────────────────────────────────────────

const NODE_TYPE_OPTIONS = [
  { value: 'all',          label: '全部类型' },
  { value: 'user_fact',    label: '事实'     },
  { value: 'entity',       label: '实体'     },
  { value: 'event',        label: '事件'     },
  { value: 'emotion',      label: '情感'     },
  { value: 'preference',   label: '偏好'     },
  { value: 'relationship', label: '关系'     },
];

function NodesTab(): JSX.Element {
  const [nodes,    setNodes]    = useState<MemoryNodeRow[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [pendingNode, setPendingNode] = useState<{ id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await memoryApi.listNodes({ limit: 200, orderBy: 'importance' });
      setNodes(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleDelete(id: string, label: string): void {
    setPendingNode({ id, label });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingNode) return;
    const { id } = pendingNode;
    setPendingNode(null);
    try {
      await useMemoryStore.getState().deleteNode(id);
      setNodes((ns) => ns.filter((n) => n.id !== id));
      showToast('节点已删除', { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const filtered = nodes.filter((n) => {
    if (typeFilter !== 'all' && n.node_type !== typeFilter) return false;
    if (search && !n.label.toLowerCase().includes(search.toLowerCase()) &&
        !n.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 shrink-0 ema-slide-down">
        <Input
          className="flex-1"
          placeholder="搜索节点…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="w-36">
          <Select
            value={typeFilter}
            onChange={setTypeFilter}
            options={NODE_TYPE_OPTIONS}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      {loading && (
        <div className="flex justify-center py-10"><Spinner size="md" /></div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState icon="i-mdi:graph-outline" title={nodes.length === 0 ? '暂无节点' : '无匹配节点'} />
      )}

      {!loading && filtered.length > 0 && (
        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-1.5 pr-2">
            {filtered.map((node, idx) => (
              <Card key={node.id} variant="elevated" padding="sm"
                className="ema-stagger-in ema-card-decorate ema-card-decorate--starfield" style={{ '--stagger-i': idx } as CSSProperties}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={NODE_TYPE_VARIANT[node.node_type]}>{NODE_TYPE_LABEL[node.node_type]}</Badge>
                      <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{node.label}</span>
                    </div>
                    {node.description && (
                      <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5 line-clamp-1">{node.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <Tooltip content={`重要度 ${(node.importance * 100).toFixed(0)}%`}>
                        <div className="w-16">
                          <Progress
                            progress={node.importance * 100}
                            animated={false}
                            height="h-1.5"
                            barClass={importanceBarClass(node.importance)}
                          />
                        </div>
                      </Tooltip>
                      <span className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-60">
                        {relativeTime(node.last_referenced_at)}
                      </span>
                    </div>
                  </div>

                  <Tooltip content="删除节点">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
                      onClick={() => void handleDelete(node.id, node.label)}
                    >
                      <span className="i-mdi:delete-outline text-base" aria-hidden />
                    </Button>
                  </Tooltip>
                </div>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      {!loading && nodes.length > 0 && (
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-40 shrink-0 text-right">
          显示 {filtered.length} / {nodes.length} 个节点
        </p>
      )}

      <ConfirmDialog
        open={!!pendingNode}
        message={pendingNode ? `确定删除节点 "${pendingNode.label}"？此操作不可撤销。` : ''}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingNode(null)}
      />
    </div>
  );
}

// ── Items tab ─────────────────────────────────────────────────────────────────

const ITEM_KIND_OPTIONS = [
  { value: 'all',       label: '全部类型' },
  { value: 'user',      label: '用户'     },
  { value: 'feedback',  label: '反馈'     },
  { value: 'project',   label: '项目'     },
  { value: 'reference', label: '参考'     },
];

function ItemsTab(): JSX.Element {
  const [items,    setItems]    = useState<MemoryItemRow[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [pendingItem, setPendingItem] = useState<{ id: string; title: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await memoryApi.listItems({ limit: 200, orderBy: 'importance' });
      setItems(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleDelete(id: string, title: string): void {
    setPendingItem({ id, title });
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingItem) return;
    const { id } = pendingItem;
    setPendingItem(null);
    try {
      await useMemoryStore.getState().deleteItem(id);
      setItems((is) => is.filter((i) => i.id !== id));
      showToast('条目已删除', { variant: 'success' });
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const filtered = items.filter((item) => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    if (search && !item.title.toLowerCase().includes(search.toLowerCase()) &&
        !item.body.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 shrink-0 ema-slide-down">
        <Input
          className="flex-1"
          placeholder="搜索条目…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="w-36">
          <Select
            value={kindFilter}
            onChange={setKindFilter}
            options={ITEM_KIND_OPTIONS}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <span className="i-mdi:refresh text-base" aria-hidden />
        </Button>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      {loading && (
        <div className="flex justify-center py-10"><Spinner size="md" /></div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState icon="i-mdi:note-outline" title={items.length === 0 ? '暂无条目' : '无匹配条目'} />
      )}

      {!loading && filtered.length > 0 && (
        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-1.5 pr-2">
            {filtered.map((item, idx) => (
              <Card key={item.id} variant="elevated" padding="sm"
                className="ema-stagger-in ema-card-decorate ema-card-decorate--starfield" style={{ '--stagger-i': idx } as CSSProperties}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={ITEM_KIND_VARIANT[item.kind]}>{ITEM_KIND_LABEL[item.kind]}</Badge>
                      <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{item.title}</span>
                    </div>
                    {item.body && (
                      <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5 line-clamp-2">{item.body}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <Tooltip content={`重要度 ${(item.importance * 100).toFixed(0)}%`}>
                        <div className="w-16">
                          <Progress
                            progress={item.importance * 100}
                            animated={false}
                            height="h-1.5"
                            barClass={importanceBarClass(item.importance)}
                          />
                        </div>
                      </Tooltip>
                      <span className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-60">
                        {relativeTime(item.last_referenced_at)}
                      </span>
                    </div>
                  </div>

                  <Tooltip content="删除条目">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
                      onClick={() => void handleDelete(item.id, item.title)}
                    >
                      <span className="i-mdi:delete-outline text-base" aria-hidden />
                    </Button>
                  </Tooltip>
                </div>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      {!loading && items.length > 0 && (
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-40 shrink-0 text-right">
          显示 {filtered.length} / {items.length} 个条目
        </p>
      )}

      <ConfirmDialog
        open={!!pendingItem}
        message={pendingItem ? `确定删除条目 "${pendingItem.title}"？此操作不可撤销。` : ''}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingItem(null)}
      />
    </div>
  );
}

// ── Maintenance tab ───────────────────────────────────────────────────────────

function MaintenanceTab(): JSX.Element {
  const maintenanceRunning = useMemoryStore((s) => s.maintenanceRunning);
  const maintenanceReport  = useMemoryStore((s) => s.maintenanceReport);
  const maintenanceError   = useMemoryStore((s) => s.maintenanceError);

  const [decayAfterDays, setDecayAfterDays] = useState('30');
  const [decayAmount,    setDecayAmount]    = useState('10');
  const [decayItems,     setDecayItems]     = useState(true);
  const [dryRun,         setDryRun]         = useState(true);

  async function runMaintenance(): Promise<void> {
    try {
      await useMemoryStore.getState().runMaintenance({
        decayAfterDays: Number(decayAfterDays) || 30,
        decayAmount:    Number(decayAmount)    || 10,
        decayItems,
        dryRun,
      });
      showToast(dryRun ? '预演完成，查看下方结果' : '维护完成', { variant: 'success' });
    } catch {
      // error shown via maintenanceError
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="ema-slide-down">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">重要度衰减</h3>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">
          降低长期未引用记忆的重要度，使其在召回时权重降低。受保护类型(事实/偏好/关系)永远不衰减。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 ema-slide-up">
        <Field label="衰减阈值(天)" description="最后引用距今超过此天数才会衰减">
          <Input
            type="number"
            min="1"
            value={decayAfterDays}
            onChange={(e) => setDecayAfterDays(e.target.value)}
          />
        </Field>

        <Field label="单次衰减量" description="每次执行将重要度减少(0–100)">
          <Input
            type="number"
            min="0"
            max="100"
            step="1"
            value={decayAmount}
            onChange={(e) => setDecayAmount(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <Switch
            checked={decayItems}
            label="同时衰减条目"
            showLabel
            onCheckedChange={setDecayItems}
          />
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={dryRun}
            label="预演模式(不实际修改)"
            showLabel
            onCheckedChange={setDryRun}
          />
        </div>
      </div>

      {maintenanceError && (
        <Callout variant="danger">{maintenanceError}</Callout>
      )}

      <div>
        <Button
          variant={dryRun ? 'secondary' : 'danger'}
          size="sm"
          loading={maintenanceRunning}
          disabled={maintenanceRunning}
          onClick={() => void runMaintenance()}
        >
          {dryRun ? '预演衰减' : '执行衰减'}
        </Button>
      </div>

      {/* Report */}
      {maintenanceReport && (
        <>
          <Divider />
          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="text-sm font-semibold text-[var(--ema-text-primary)]">执行结果</p>
              {maintenanceReport.dryRun && <Badge variant="warn">预演</Badge>}
              <span className="text-xs font-semibold text-[var(--ema-text-tertiary)]">
                衰减节点 {maintenanceReport.decayedNodes}，衰减条目 {maintenanceReport.decayedItems}
              </span>
            </div>

            {maintenanceReport.preview.nodes.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-1.5">受影响节点(前 {maintenanceReport.preview.nodes.length} 条)</p>
                <ScrollArea viewportClassName="max-h-40">
                  <div className="flex flex-col gap-1 pr-1">
                    {maintenanceReport.preview.nodes.map((n) => (
                      <div key={n.id} className="flex items-center gap-2 text-xs">
                        <Badge variant={NODE_TYPE_VARIANT[n.nodeType]}>{NODE_TYPE_LABEL[n.nodeType]}</Badge>
                        <span className="flex-1 truncate font-semibold text-[var(--ema-text-secondary)]">{n.label}</span>
                        <span className="font-semibold text-[var(--ema-text-tertiary)] opacity-60 tabular-nums shrink-0">
                          {(n.currentImportance * 100).toFixed(0)}% → {(n.newImportance * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {maintenanceReport.preview.items.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mb-1.5">受影响条目(前 {maintenanceReport.preview.items.length} 条)</p>
                <ScrollArea viewportClassName="max-h-40">
                  <div className="flex flex-col gap-1 pr-1">
                    {maintenanceReport.preview.items.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate font-semibold text-[var(--ema-text-secondary)]">{item.title}</span>
                        <span className="font-semibold text-[var(--ema-text-tertiary)] opacity-60 tabular-nums shrink-0">
                          {(item.currentImportance * 100).toFixed(0)}% → {(item.newImportance * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {maintenanceReport.preview.nodes.length === 0 && maintenanceReport.preview.items.length === 0 && (
              <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] opacity-40">此次无需衰减的记忆</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

type MemorySection = 'overview' | 'nodes' | 'items' | 'maintenance';

export function MemoryTab(): JSX.Element {
  const [section, setSection] = useState<MemorySection>('overview');

  const tabItems = [
    { value: 'overview',     label: '概览',   icon: 'i-mdi:chart-box-outline',   content: <OverviewTab />     },
    { value: 'nodes',        label: '节点',   icon: 'i-mdi:graph-outline',        content: <NodesTab />        },
    { value: 'items',        label: '条目',   icon: 'i-mdi:note-text-outline',    content: <ItemsTab />        },
    { value: 'maintenance',  label: '维护',   icon: 'i-mdi:wrench-outline',       content: <MaintenanceTab />  },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">记忆系统</h2>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">浏览和管理 Agent 的长期记忆节点与条目</p>
      </div>

      <Tabs
        value={section}
        onChange={(v) => setSection(v as MemorySection)}
        items={tabItems}
        variant="pill"
        orientation="horizontal"
        className="flex-1 min-h-0"
      />
    </div>
  );
}
