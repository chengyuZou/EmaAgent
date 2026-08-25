import { useState, useEffect, useCallback, type CSSProperties, type JSX } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog,
  Input, Progress, ScrollArea, Select, Spinner, EmptyState, Tooltip,
} from '@ema-agent/ui';
import { useMemoryStore } from '../../stores/memory-store.js';
import { memoryApi, type MemoryItemRow } from '../../api/memory.js';
import { showToast } from '../../lib/toast.js';
import { ITEM_KIND_LABEL, ITEM_KIND_VARIANT, relativeTime, importanceBarClass } from './memoryLabels.js';

const ITEM_KIND_OPTIONS = [
  { value: 'all',       label: '全部类型' },
  { value: 'user',      label: '用户'     },
  { value: 'feedback',  label: '反馈'     },
  { value: 'project',   label: '项目'     },
  { value: 'reference', label: '参考'     },
];

export function ItemsTab(): JSX.Element {
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