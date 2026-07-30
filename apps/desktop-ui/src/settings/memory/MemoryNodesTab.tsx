import { useEffect, useState, useCallback, type JSX, type CSSProperties } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog,
  Input, Progress, ScrollArea, Select, Spinner, EmptyState, Tooltip,
} from '@ema-agent/ui';
import { useMemoryStore } from '../../stores/memory-store.js';
import { memoryApi, type MemoryNodeRow } from '../../api/memory.js';
import { showToast } from '../../lib/toast.js';
import { importanceBarClass, relativeTime } from './memoryLabels.js';
import { NODE_TYPE_LABEL, NODE_TYPE_VARIANT } from './memoryLabels.js';

const NODE_TYPE_OPTIONS = [
  { value: 'all',          label: '全部类型' },
  { value: 'user_fact',    label: '事实'     },
  { value: 'entity',       label: '实体'     },
  { value: 'event',        label: '事件'     },
  { value: 'emotion',      label: '情感'     },
  { value: 'preference',   label: '偏好'     },
  { value: 'relationship', label: '关系'     },
];

export function NodesTab(): JSX.Element {
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