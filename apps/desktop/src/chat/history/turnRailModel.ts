// 计算 TurnRail 的可视索引窗口与悬停刻度邻域强度。
import type { TurnIndexPage } from '../../api/sessions.js';

type TurnIndexItem = TurnIndexPage['items'][number];

export const TURN_RAIL_ROW_HEIGHT = 8;
export const TURN_RAIL_MIN_VISIBLE = 12;

export interface TurnRailMarkVisual {
  scale: number;
  opacity: number;
  emphasis: 'idle' | 'nearby' | 'hovered' | 'current';
}

export function turnRailCapacity(height: number): number {
  return Math.max(TURN_RAIL_MIN_VISIBLE, Math.floor(Math.max(height - 24, 0) / TURN_RAIL_ROW_HEIGHT));
}

export function visibleTurnIndex(
  newestFirstItems: readonly TurnIndexItem[],
  offset: number,
  capacity: number,
): TurnIndexItem[] {
  return newestFirstItems
    .slice(offset, offset + capacity)
    .reverse();
}

export function turnRailMarkVisual(
  index: number,
  hoveredIndex: number | null,
  isCurrent: boolean,
): TurnRailMarkVisual {
  if (hoveredIndex === null) {
    return isCurrent
      ? { scale: 0.72, opacity: 0.92, emphasis: 'current' }
      : { scale: 0.24, opacity: 0.44, emphasis: 'idle' };
  }

  const distance = Math.abs(index - hoveredIndex);
  if (distance === 0) return { scale: 1, opacity: 1, emphasis: 'hovered' };
  if (distance === 1) return { scale: 0.72, opacity: 0.88, emphasis: 'nearby' };
  if (distance === 2) return { scale: 0.52, opacity: 0.72, emphasis: 'nearby' };
  if (distance === 3) return { scale: 0.36, opacity: 0.58, emphasis: 'nearby' };
  return isCurrent
    ? { scale: 0.72, opacity: 0.92, emphasis: 'current' }
    : { scale: 0.24, opacity: 0.38, emphasis: 'idle' };
}
