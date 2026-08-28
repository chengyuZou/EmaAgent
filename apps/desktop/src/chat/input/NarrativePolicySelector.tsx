// 选择 Session 下一 Turn 的剧情检索策略。
import type { JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { NarrativePolicy } from '@ema-agent/session';

const LABELS: Record<NarrativePolicy, string> = {
  auto: '剧情自动',
  always: '剧情始终',
  off: '剧情关闭',
};

export function NarrativePolicySelector({ value, onChange }: {
  value: NarrativePolicy;
  onChange(value: NarrativePolicy): void;
}): JSX.Element {
  const items: MenuItem[] = (['auto', 'always', 'off'] as const).map(policy => ({
    kind: 'item',
    label: LABELS[policy],
    icon: value === policy ? 'i-lucide:check' : 'i-lucide:circle',
    onSelect: () => onChange(policy),
  }));
  return (
    <DropdownMenu side="top" align="start" widthClass="min-w-40" items={items} trigger={(
      <Button variant="ghost" className={`gap-1 rounded-lg px-2 py-1 text-xs ${value === 'always' ? 'text-[var(--ema-warning)]' : 'text-[var(--ema-text-secondary)]'}`}>
        <span className="i-lucide:book-open text-sm" aria-hidden />
        {LABELS[value]}
        <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
      </Button>
    )} />
  );
}

