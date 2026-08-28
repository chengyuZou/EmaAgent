// 选择 Session 下一 Turn 的 Chat/Work 执行模式。
import type { JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { ExecutionProfile } from '@ema-agent/session';

const LABELS: Record<ExecutionProfile, string> = { chat: 'Chat', work: 'Work' };
const ICONS: Record<ExecutionProfile, string> = {
  chat: 'i-lucide:message-circle',
  work: 'i-lucide:briefcase-business',
};

export function ExecutionProfileSelector({ value, onChange }: {
  value: ExecutionProfile;
  onChange(value: ExecutionProfile): void;
}): JSX.Element {
  const items: MenuItem[] = (['chat', 'work'] as const).map(profile => ({
    kind: 'item',
    label: LABELS[profile],
    icon: value === profile ? 'i-lucide:check' : ICONS[profile],
    onSelect: () => onChange(profile),
  }));
  return (
    <DropdownMenu side="top" align="end" widthClass="min-w-36" items={items} trigger={(
      <Button variant="ghost" className="gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ema-text-secondary)]">
        <span className={`${ICONS[value]} text-sm`} aria-hidden />
        {LABELS[value]}
        <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
      </Button>
    )} />
  );
}
