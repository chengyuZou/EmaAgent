// Work 模式只在当前激活知识库内选择文档范围；空选择表示整个激活库。
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Checkbox, Popover, ScrollArea, Spinner } from '@ema-agent/ui';
import { knowledgeApi, type DocumentAsset } from '../../api/knowledge.js';

const PAGE_SIZE = 40;

export function KbButton({ visible, selectedIds, onChange }: {
  visible: boolean;
  selectedIds: readonly string[];
  onChange(ids: readonly string[]): void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DocumentAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const page = await knowledgeApi.listDocuments({ cursor, limit: PAGE_SIZE });
      setItems(previous => cursor ? [...previous, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open && items.length === 0) void load(); }, [open, items.length, load]);
  if (!visible) return null;
  const selected = new Set(selectedIds);
  return (
    <Popover open={open} onOpenChange={setOpen} side="top" align="start" widthClass="w-72" trigger={(
      <Button variant="ghost" className="gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ema-text-secondary)]">
        <span className="i-lucide:library text-sm" aria-hidden />
        {selectedIds.length > 0 ? `${selectedIds.length} 个文件` : 'KB 全部'}
        <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
      </Button>
    )}>
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-[var(--ema-text-secondary)]">当前激活知识库</span>
        {selectedIds.length > 0 && <Button variant="ghost" size="sm" onClick={() => onChange([])}>使用全部</Button>}
      </div>
      <ScrollArea viewportClassName="max-h-52">
        <div className="space-y-0.5 pr-1">
          {items.map(item => {
            const checked = selected.has(item.id);
            return (
              <button type="button" key={item.id} className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${checked ? 'bg-[var(--ema-primary-muted)]' : 'hover:bg-[var(--ema-surface-2)]'}`} onClick={() => onChange(checked ? selectedIds.filter(id => id !== item.id) : [...selectedIds, item.id])}>
                <Checkbox checked={checked} className="pointer-events-none" label={item.fileName} />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]">{item.fileName}</span>
                {item.status !== 'ready' && <span className="text-[10px] text-[var(--ema-text-tertiary)]">{item.status === 'failed' ? '失败' : '处理中'}</span>}
              </button>
            );
          })}
          {loading && <div className="flex justify-center py-4"><Spinner size="sm" /></div>}
          {!loading && items.length === 0 && <p className="py-4 text-center text-xs text-[var(--ema-text-tertiary)]">当前知识库没有文档</p>}
        </div>
      </ScrollArea>
      {nextCursor && <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => void load(nextCursor)}>加载更多</Button>}
    </Popover>
  );
}
