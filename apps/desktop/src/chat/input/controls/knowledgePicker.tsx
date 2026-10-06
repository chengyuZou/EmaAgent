import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Button, Checkbox, Popover, ScrollArea, Spinner } from '@ema-agent/ui';
import { knowledgeApi, type DocumentAsset } from '../../../api/knowledge.js';
import { useKnowledgeStore } from '../../../stores/knowledge.js';

const KB_PAGE_SIZE = 40;

export function KbButton({
  visible,
  selectedIds,
  onChange,
}: {
  visible: boolean;
  selectedIds: readonly string[];
  onChange(ids: readonly string[]): void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DocumentAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const activeKbId = useKnowledgeStore((state) => (
    state.libs.find((library) => library.isActive)?.id
  ));
  const libsError = useKnowledgeStore(state => state.libsError);
  const libsLoading = useKnowledgeStore(state => state.libsLoading);

  const load = useCallback(
    async (cursor?: string) => {
      if (!activeKbId) return;
      const request = ++loadRequest.current;
      setLoading(true);
      setLoadError(null);
      try {
        const page = await knowledgeApi.listDocuments(activeKbId, {
          cursor,
          limit: KB_PAGE_SIZE,
        });
        if (request !== loadRequest.current) return;
        setItems((previous) => (
          cursor ? [...previous, ...page.items] : page.items
        ));
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (request === loadRequest.current) {
          setLoadError(error instanceof Error ? error.message : '读取知识库文档失败');
        }
      } finally {
        if (request === loadRequest.current) setLoading(false);
      }
    },
    [activeKbId],
  );

  useEffect(() => {
    loadRequest.current += 1;
    setItems([]);
    setNextCursor(null);
    setLoadError(null);
  }, [activeKbId]);

  useEffect(() => {
    if (open && activeKbId) void load();
  }, [open, activeKbId, load]);

  // 已加载页面内的文档若不再 ready, 从未发送草稿移除; 其他页不凭缺席猜它已删除.
  useEffect(() => {
    const unusable = new Set(items.filter(item => item.status !== 'ready').map(item => item.id));
    if (selectedIds.some(id => unusable.has(id))) {
      onChange(selectedIds.filter(id => !unusable.has(id)));
    }
  }, [items, selectedIds, onChange]);

  // 收起时顺带关闭弹层, 避免弹层内容经 portal 浮在收起后的按钮上.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  const selected = new Set(selectedIds);

  // 每页最多 40 项. 已选集合在勾选时会改变, 此处加 memo 不能跳过那次必要更新.
  return (
    /* 不卸载只收起: 切 Chat/Work 时工具条宽度平滑变化, 后排按钮不瞬移(动画铁律). */
    <div
      className={`overflow-hidden transition-all duration-[var(--ema-duration-base)] ${
        visible ? 'max-w-24 opacity-100' : 'invisible max-w-0 opacity-0'
      }`}
    >
      <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      widthClass="w-72"
      trigger={(
        <Button
          variant="ghost"
          className="ema-chat-btn"
        >
          {selectedIds.length > 0 ? `${selectedIds.length} 个文件` : 'KB'}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-[var(--ema-text-secondary)]">
          当前激活知识库
        </span>
      </div>

      <ScrollArea viewportClassName="max-h-52">
        <div className="space-y-0.5 pr-1">
          {items.map((item) => {
            const checked = selected.has(item.id);

            return (
              <button
                type="button"
                key={item.id}
                disabled={item.status !== 'ready'}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  checked
                    ? 'bg-[var(--ema-primary-muted)]'
                    : 'hover:bg-[var(--ema-surface-2)]'
                }`}
                onClick={() => onChange(
                  checked
                    ? selectedIds.filter((id) => id !== item.id)
                    : [...selectedIds, item.id],
                )}
              >
                <Checkbox
                  checked={checked}
                  className="pointer-events-none"
                  label={item.fileName}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]">
                  {item.fileName}
                </span>
                {item.status !== 'ready' && (
                  <span className="text-[10px] text-[var(--ema-text-tertiary)]">
                    {item.status === 'failed' ? '失败' : '处理中'}
                  </span>
                )}
              </button>
            );
          })}

          {loading && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}
          {!activeKbId && !libsLoading && (
            <p className="py-4 text-center text-xs text-[var(--ema-text-tertiary)]">
              {libsError ? '知识库列表读取失败' : '没有激活知识库'}
            </p>
          )}
          {loadError && (
            <p className="py-4 text-center text-xs text-[var(--ema-danger)]">{loadError}</p>
          )}
          {!loading && activeKbId && !loadError && items.every(item => item.status !== 'ready') && (
            <p className="py-4 text-center text-xs text-[var(--ema-text-tertiary)]">
              当前知识库没有就绪文档
            </p>
          )}
        </div>
      </ScrollArea>

      {nextCursor && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          onClick={() => void load(nextCursor)}
        >
          加载更多
        </Button>
      )}
    </Popover>
    </div>
  );
}
