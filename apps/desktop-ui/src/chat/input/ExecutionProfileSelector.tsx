// 让用户选择下一 Turn 的 Chat/Work 能力范围与 Narrative 检索策略。
import type { JSX } from 'react';
import { Button, DropdownMenu, type MenuItem } from '@ema-agent/ui';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';

interface ExecutionProfileSelectorProps {
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  onExecutionProfileChange(profile: ExecutionProfile): void;
  onNarrativePolicyChange(policy: NarrativePolicy): void;
}

const PROFILE_LABELS: Record<ExecutionProfile, string> = {
  chat: 'Chat',
  work: 'Work',
};

const PROFILE_ICONS: Record<ExecutionProfile, string> = {
  chat: 'i-lucide:message-circle',
  work: 'i-lucide:briefcase-business',
};

export function ExecutionProfileSelector({
  executionProfile,
  narrativePolicy,
  onExecutionProfileChange,
  onNarrativePolicyChange,
}: ExecutionProfileSelectorProps): JSX.Element {
  const selectedIcon = 'i-lucide:check';
  const items: MenuItem[] = [
    {
      kind: 'item',
      label: 'Chat',
      icon: executionProfile === 'chat' ? selectedIcon : 'i-lucide:message-circle',
      onSelect: () => onExecutionProfileChange('chat'),
    },
    {
      kind: 'item',
      label: 'Work',
      icon: executionProfile === 'work' ? selectedIcon : 'i-lucide:briefcase-business',
      onSelect: () => onExecutionProfileChange('work'),
    },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: '剧情资料',
      icon: 'i-lucide:book-open',
      items: [
        narrativeItem('auto', '自动', narrativePolicy, onNarrativePolicyChange),
        narrativeItem('always', '始终检索', narrativePolicy, onNarrativePolicyChange),
        narrativeItem('off', '关闭（可能缺少剧情细节）', narrativePolicy, onNarrativePolicyChange),
      ],
    },
  ];

  return (
    <DropdownMenu
      side="top"
      align="start"
      widthClass="min-w-40"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ema-text-secondary)] transition-colors duration-[var(--ema-duration-base)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
        >
          <span className={`${PROFILE_ICONS[executionProfile]} text-sm`} aria-hidden />
          <span>{PROFILE_LABELS[executionProfile]}</span>
          {narrativePolicy === 'always' && (
            <span className="i-lucide:book-open text-[11px] text-[var(--ema-warning)]" aria-label="剧情资料始终检索" />
          )}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

function narrativeItem(
  policy: NarrativePolicy,
  label: string,
  selected: NarrativePolicy,
  onSelect: (policy: NarrativePolicy) => void,
): MenuItem {
  return {
    kind: 'item',
    label,
    icon: selected === policy ? 'i-lucide:check' : 'i-lucide:circle',
    onSelect: () => onSelect(policy),
  };
}
