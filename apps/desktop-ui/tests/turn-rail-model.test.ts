// 验证 TurnRail 的窗口裁剪顺序与悬停邻域强度。
import { describe, expect, it } from 'vitest';
import type { TurnIndexItemWire } from '@ema-agent/session';
import {
  turnRailCapacity,
  turnRailMarkVisual,
  visibleTurnIndex,
} from '../src/chat/history/turnRailModel.js';

function turn(turnId: string): TurnIndexItemWire {
  return {
    turnId: turnId as TurnIndexItemWire['turnId'],
    startedAt: 0,
    completedAt: 1,
    status: 'completed',
    triggerType: 'user',
    executionProfile: 'chat',
    preview: turnId,
  };
}

describe('TurnRail model', () => {
  it('可视高度很小时仍保留最低导航容量', () => {
    expect(turnRailCapacity(0)).toBe(12);
    expect(turnRailCapacity(200)).toBe(22);
  });

  it('从最新优先索引中截取窗口，并按界面时间顺序显示', () => {
    const visible = visibleTurnIndex(
      [turn('5'), turn('4'), turn('3'), turn('2'), turn('1')],
      1,
      3,
    );
    expect(visible.map((item) => item.turnId)).toEqual(['2', '3', '4']);
  });

  it('悬停刻度两侧按距离对称衰减', () => {
    expect(turnRailMarkVisual(2, 2, false).scale).toBe(1);
    expect(turnRailMarkVisual(1, 2, false)).toEqual(
      turnRailMarkVisual(3, 2, false),
    );
    expect(turnRailMarkVisual(0, 2, false).scale).toBeLessThan(
      turnRailMarkVisual(1, 2, false).scale,
    );
  });

  it('没有悬停时仍突出当前 Turn', () => {
    expect(turnRailMarkVisual(1, null, true).emphasis).toBe('current');
    expect(turnRailMarkVisual(1, null, false).emphasis).toBe('idle');
  });
});
