// 展示轻量 Turn 索引，并把悬停位置转换成可快速跳转的声波式导航刻度。
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { Tooltip, TooltipProvider } from '@ema-agent/ui';

import type { TurnIndexPage } from '../../api/sessions.js';
import { EMPTY_SESSION_HISTORY, useSessionHistoryStore } from '../../stores/sessionHistory.js';

type TurnIndexItem = TurnIndexPage['items'][number];

interface TurnRailProps {
  sessionId: string;
  visibleTurnIds: ReadonlySet<string>;
  onSelectTurn(turnId: string): void | Promise<void>;
}

type TurnRailMarkStyle = CSSProperties & {
  '--ema-turn-rail-scale': number;
  '--ema-turn-rail-opacity': number;
};

const WHEEL_STEP = 3;
const WHEEL_THRESHOLD = 48;
const TURN_RAIL_ROW_HEIGHT = 8;
const TURN_RAIL_MIN_VISIBLE = 12;

function turnRailCapacity(height: number): number {
  return Math.max(TURN_RAIL_MIN_VISIBLE, Math.floor(Math.max(height - 24, 0) / TURN_RAIL_ROW_HEIGHT));
}

function visibleTurnIndex(items: readonly TurnIndexItem[], offset: number, capacity: number): TurnIndexItem[] {
  return items.slice(offset, offset + capacity).reverse();
}

function turnRailMarkVisual(index: number, hoveredIndex: number | null, isCurrent: boolean): { scale: number; opacity: number; emphasis: 'idle' | 'nearby' | 'hovered' | 'current' } {
  if (hoveredIndex === null) return isCurrent ? { scale: 0.72, opacity: 0.92, emphasis: 'current' } : { scale: 0.24, opacity: 0.44, emphasis: 'idle' };
  const distance = Math.abs(index - hoveredIndex);
  if (distance === 0) return { scale: 1, opacity: 1, emphasis: 'hovered' };
  if (distance === 1) return { scale: 0.72, opacity: 0.88, emphasis: 'nearby' };
  if (distance === 2) return { scale: 0.52, opacity: 0.72, emphasis: 'nearby' };
  if (distance === 3) return { scale: 0.36, opacity: 0.58, emphasis: 'nearby' };
  return isCurrent ? { scale: 0.72, opacity: 0.92, emphasis: 'current' } : { scale: 0.24, opacity: 0.38, emphasis: 'idle' };
}

export function TurnNavigationRail({ sessionId, visibleTurnIds, onSelectTurn }: TurnRailProps): JSX.Element | null {
  const [railElement, setRailElement] = useState<HTMLDivElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const centeredViewRef = useRef<{ turnId: string; capacity: number } | null>(null);
  const [height, setHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const history = useSessionHistoryStore(
    (state) => state.bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY,
  );

  useEffect(() => {
    void useSessionHistoryStore.getState().loadTurnIndex(sessionId);
  }, [sessionId, history.turnIndexLoaded]);

  useEffect(() => {
    if (!railElement) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(railElement);
    return () => observer.disconnect();
  }, [railElement]);

  const capacity = turnRailCapacity(height);
  const visibleItems = useMemo(
    () => visibleTurnIndex(history.turnIndexItems, offset, capacity),
    [capacity, history.turnIndexItems, offset],
  );

  useEffect(() => {
    if (!railElement) return;

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      wheelDeltaRef.current += event.deltaY;
      if (Math.abs(wheelDeltaRef.current) < WHEEL_THRESHOLD) return;

      const direction = wheelDeltaRef.current > 0 ? -1 : 1;
      wheelDeltaRef.current = 0;
      setHoveredIndex(null);
      setOffset((current) => {
        const maximum = Math.max(0, history.turnIndexItems.length - capacity);
        const next = Math.max(0, Math.min(maximum, current + direction * WHEEL_STEP));
        if (
          direction > 0
          && next + capacity >= history.turnIndexItems.length - WHEEL_STEP
          && history.turnIndexNextCursor
        ) {
          void useSessionHistoryStore.getState().loadMoreTurnIndex(sessionId);
        }
        return next;
      });
    };

    // React 在 Chromium 根节点委托的 wheel 监听是 passive；导航轨需要独占这次滚轮。
    railElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => railElement.removeEventListener('wheel', handleWheel);
  }, [capacity, history.turnIndexItems.length, history.turnIndexNextCursor, railElement, sessionId]);

  useEffect(() => {
    setOffset(0);
    setHoveredIndex(null);
    centeredViewRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const currentTurnId = history.currentTurnId;
    const centeredView = centeredViewRef.current;
    if (
      !currentTurnId
      || (centeredView?.turnId === currentTurnId && centeredView.capacity === capacity)
    ) return;
    const currentIndex = history.turnIndexItems.findIndex(
      (item) => item.turnId === history.currentTurnId,
    );
    if (currentIndex < 0) return;
    centeredViewRef.current = { turnId: currentTurnId, capacity };
    setOffset(centeredTurnOffset(history.turnIndexItems.length, currentIndex, capacity));
  }, [capacity, history.currentTurnId, history.turnIndexItems]);

  if (!history.turnIndexLoading && history.turnIndexItems.length === 0) return null;

  return (
    <TooltipProvider delayDuration={120}>
      <div
        ref={setRailElement}
        className="absolute left-2 top-1/2 z-10 flex h-[64%] max-h-[36rem] w-11 -translate-y-1/2 flex-col items-center justify-center overflow-hidden bg-transparent"
        onPointerLeave={() => setHoveredIndex(null)}
        aria-label="Turn 快速导航"
      >
        {visibleItems.map((item, index) => {
          const isVisible = visibleTurnIds.has(item.turnId);
          const visual = turnRailMarkVisual(index, hoveredIndex, isVisible);
          const style: TurnRailMarkStyle = {
            '--ema-turn-rail-scale': visual.scale,
            '--ema-turn-rail-opacity': visual.opacity,
          };
          return (
            <Tooltip
              key={item.turnId}
              side="right"
              align="center"
              sideOffset={8}
              content={<TurnRailPreview item={item} />}
            >
              <button
                type="button"
                className="group flex h-2 w-10 shrink-0 items-center border-0 bg-transparent p-0 outline-none"
                onPointerEnter={() => setHoveredIndex(index)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
                onClick={() => void onSelectTurn(item.turnId)}
                aria-label={`跳转到 ${formatTurnTime(item.createdAt)} 的 Turn`}
                aria-current={item.turnId === history.currentTurnId ? 'step' : undefined}
              >
                <span
                  className="ema-turn-rail-mark block h-px w-9 rounded-full"
                  data-emphasis={visual.emphasis}
                  style={style}
                />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export function centeredTurnOffset(
  itemCount: number,
  currentIndex: number,
  capacity: number,
): number {
  const maximum = Math.max(0, itemCount - capacity);
  const centered = Math.max(0, currentIndex - Math.floor(capacity / 2));
  return Math.min(centered, maximum);
}

function TurnRailPreview({ item }: { item: TurnIndexItem }): JSX.Element {
  return (
    <div className="w-64 py-1">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
        <span>{formatTurnTime(item.createdAt)}</span>
        <span>{item.sessionMode === 'work' ? 'Work' : 'Chat'}</span>
        <span>{formatTurnStatus(item.status)}</span>
      </div>
      <div className="line-clamp-3 text-xs leading-5 text-[var(--ema-text-primary)]">
        {item.preview || '这一轮没有可显示的文本摘要'}
      </div>
    </div>
  );
}

function formatTurnTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatTurnStatus(status: TurnIndexItem['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '进行中';
  if (status === 'aborted') return '已停止';
  if (status === 'failed') return '失败';
  return status;
}
