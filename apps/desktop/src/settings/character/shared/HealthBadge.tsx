// 角色健康徽章:编辑器头部显示降级/不可用状态与 issues 明细,healthy 不添噪。
import { useEffect, type JSX } from 'react';
import { Badge, Popover } from '@ema-agent/ui';
import { useCardStore } from '../../../stores/card-store.js';

export function HealthBadge({ cardId }: { cardId: string }): JSX.Element | null {
  const health = useCardStore((s) => s.healthMap[cardId as string]);

  useEffect(() => {
    void useCardStore.getState().refreshHealth(cardId);
  }, [cardId]);

  if (!health || health.status === 'healthy') return null;
  const invalid = health.status === 'invalid';

  return (
    <Popover
      side="bottom"
      align="start"
      widthClass="w-80"
      trigger={
        <span className="inline-flex cursor-help">
          <Badge variant={invalid ? 'danger' : 'warn'} dot>
            {invalid ? '不可用' : '降级'}
          </Badge>
        </span>
      }
    >
      <div className="flex flex-col gap-1.5 p-1">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)]">
          {invalid ? '该角色无法启动对话:' : '该角色部分资源不可用,将按降级链展示:'}
        </p>
        {health.issues.map((issue, i) => (
          <p key={i} className="text-xs text-[var(--ema-text-tertiary)] leading-relaxed">
            · {issue.message}
          </p>
        ))}
      </div>
    </Popover>
  );
}
