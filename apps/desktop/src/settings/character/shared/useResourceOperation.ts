// 资源操作期间的七阶段轮询:HTTP 请求本身阻塞到完成,这里只提供等待中的阶段文案。
import { useEffect, useState } from 'react';
import { cardsApi } from '../../../api/cards.js';
import type { CharacterResourceOperation } from '@ema-agent/characters';

const STAGE_LABELS: Record<string, string> = {
  queued:     '排队中…',
  validating: '校验中…',
  staging:    '暂存中…',
  publishing: '发布中…',
  finalizing: '收尾中…',
  completed:  '已完成',
  failed:     '失败',
};

export function operationStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** active=true 期间每 1.5s 轮询一次该角色的当前/最近资源操作;失败保留旧值。 */
export function useResourceOperation(
  cardId: string | null,
  active: boolean,
): CharacterResourceOperation | null {
  const [operation, setOperation] = useState<CharacterResourceOperation | null>(null);

  useEffect(() => {
    if (!cardId || !active) return;
    let disposed = false;
    const tick = async (): Promise<void> => {
      try {
        const op = await cardsApi.resourceOperation(cardId);
        if (!disposed) setOperation(op);
      } catch {
        // 轮询失败不清空,下一次 tick 自愈。
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [cardId, active]);

  return operation;
}
