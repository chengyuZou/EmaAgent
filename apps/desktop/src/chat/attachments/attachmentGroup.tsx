import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactElement } from 'react';
import { Button } from '@ema-agent/ui';

interface AttachmentGroupProps {
  readonly label: string;
  readonly children: readonly ReactElement[];
}

export function AttachmentGroup({ label, children }: AttachmentGroupProps): JSX.Element {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState({ count: children.length, height: 0 });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    function measure(): void {
      const maxRows = Number(getComputedStyle(list!).getPropertyValue('--ema-attachment-visible-rows')) || 2;
      let row = 0;
      let rowTop = -1;
      let count = 0;
      let height = 0;
      for (const item of Array.from(list!.children) as HTMLElement[]) {
        if (Math.abs(item.offsetTop - rowTop) > 1 || row === 0) {
          row += 1;
          rowTop = item.offsetTop;
        }
        if (row > maxRows) break;
        count += 1;
        height = Math.max(height, item.offsetTop + item.offsetHeight);
      }
      setCollapsed(current => (
        current.count === count && current.height === height ? current : { count, height }
      ));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [children]);

  const overflowing = collapsed.count < children.length;
  return (
    <div className="ema-attachment-group">
      <div
        id={id}
        className="ema-attachment-group-viewport"
        style={{ height: !expanded && overflowing ? collapsed.height : undefined }}
      >
        <div ref={listRef} className="ema-attachment-group-list">
          {children.map((child, index) => {
            const hidden = !expanded && index >= collapsed.count;
            return (
              <div
                key={child.key ?? index}
                className="ema-attachment-group-item"
                data-collapsed={hidden}
                aria-hidden={hidden || undefined}
                ref={element => {
                  // 隐藏项目保留占位供换行测量, 但不能接收键盘焦点或打开预览.
                  if (element) element.inert = hidden;
                }}
              >
                {child}
              </div>
            );
          })}
        </div>
      </div>
      {overflowing && (
        <Button
          variant="ghost"
          size="sm"
          className="ema-attachment-group-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? `收起${label}` : `展开全部${label} (共 ${children.length} 项)`}
        </Button>
      )}
    </div>
  );
}
