// 展示轻量 Turn 索引，并把悬停位置转换成可快速跳转的声波式导航刻度。
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type WheelEvent,
} from 'react';
import { Tooltip, TooltipProvider } from '@ema-agent/ui';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { TurnIndexItemWire } from '@ema-agent/session';
import {
  EMPTY_SESSION_HISTORY,
  useSessionHistoryStore,
} from './sessionHistoryStore.js';
import {
  turnRailCapacity,
  turnRailMarkVisual,
  visibleTurnIndex,
} from './turnRailModel.js';

interface TurnRailProps {
  sessionId: SessionId;
  onSelectTurn(turnId: TurnId): void | Promise<void>;
}

type TurnRailMarkStyle = CSSProperties & {
  '--ema-turn-rail-scale': number;
  '--ema-turn-rail-opacity': number;
};

const WHEEL_STEP = 3;
const WHEEL_THRESHOLD = 48;

export function TurnRail({ sessionId, onSelectTurn }: TurnRailProps): JSX.Element | null {
  const railRef = useRef<HTMLDivElement | null>(null);
  const wheelDeltaRef = useRef(0);
  const centeredTurnRef = useRef<string | null>(null);
  const [height, setHeight] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const history = useSessionHistoryStore(
    (state) => state.bySession.get(sessionId as string) ?? EMPTY_SESSION_HISTORY,
  );

  useEffect(() => {
    void useSessionHistoryStore.getState().loadTurnIndex(sessionId);
  }, [sessionId, history.turnIndexLoaded]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  const capacity = turnRailCapacity(height);
  const visibleItems = useMemo(
    () => visibleTurnIndex(history.turnIndexItems, offset, capacity),
    [capacity, history.turnIndexItems, offset],
  );

  useEffect(() => {
    setOffset(0);
    setHoveredIndex(null);
    centeredTurnRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const currentTurnId = history.currentTurnId as string | undefined;
    if (!currentTurnId || centeredTurnRef.current === currentTurnId) return;
    const currentIndex = history.turnIndexItems.findIndex(
      (item) => item.turnId === history.currentTurnId,
    );
    if (currentIndex < 0) return;
    centeredTurnRef.current = currentTurnId;
    setOffset((current) => {
      if (currentIndex >= current && currentIndex < current + capacity) return current;
      const centered = Math.max(0, currentIndex - Math.floor(capacity / 2));
      return Math.min(centered, Math.max(0, history.turnIndexItems.length - capacity));
    });
  }, [capacity, history.currentTurnId, history.turnIndexItems]);

  function handleWheel(event: WheelEvent<HTMLDivElement>): void {
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
  }

  if (!history.turnIndexLoading && history.turnIndexItems.length === 0) return null;

  return (
    <TooltipProvider delayDuration={120}>
      <div
        ref={railRef}
        className="absolute inset-y-5 left-2 z-10 flex w-11 flex-col justify-end overflow-hidden bg-transparent"
        onPointerLeave={() => setHoveredIndex(null)}
        onWheel={handleWheel}
        aria-label="Turn 快速导航"
      >
        {visibleItems.map((item, index) => {
          const isCurrent = item.turnId === history.currentTurnId;
          const visual = turnRailMarkVisual(index, hoveredIndex, isCurrent);
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
                onClick={() => void onSelectTurn(item.turnId as TurnId)}
                aria-label={`跳转到 ${formatTurnTime(item.startedAt)} 的 Turn`}
                aria-current={isCurrent ? 'step' : undefined}
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

function TurnRailPreview({ item }: { item: TurnIndexItemWire }): JSX.Element {
  return (
    <div className="w-64 py-1">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
        <span>{formatTurnTime(item.startedAt)}</span>
        <span>{item.executionProfile === 'work' ? 'Work' : 'Chat'}</span>
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

function formatTurnStatus(status: TurnIndexItemWire['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '进行中';
  if (status === 'aborted') return '已停止';
  if (status === 'pending') return '等待中';
  if (status === 'failed') return '失败';
  return status;
}
