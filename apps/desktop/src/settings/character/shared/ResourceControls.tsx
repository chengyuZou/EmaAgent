// 资源行共享的原子控件:主用徽章。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';

export function PrimaryBadge({ isPrimary }: { isPrimary: boolean }): JSX.Element | null {
  if (!isPrimary) return null;
  return <Badge variant="success" dot>主用</Badge>;
}
