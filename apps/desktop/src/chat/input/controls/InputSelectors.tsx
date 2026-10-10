import type { JSX } from 'react';
import { Button, DropdownMenu, IconButton, type MenuItem } from '@ema-agent/ui';
import type { SessionMode } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';
import { ServerApiError } from '../../../api/client.js';
import type { ChatDraft } from '../../../stores/chatDraft.js';
import { useSessionStore } from '../../../stores/session.js';
import { showToast } from '../../../lib/toast.js';

const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  chat: 'Chat',
  work: 'Work',
};

const SESSION_MODE_ICONS: Record<SessionMode, string> = {
  chat: 'i-lucide:message-circle',
  work: 'i-lucide:briefcase-business',
};

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: '默认权限',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '绕过权限',
  plan: 'Plan',
};

const PERMISSION_MODE_ICONS: Record<PermissionMode, string> = {
  default: 'i-lucide:shield-question',
  acceptEdits: 'i-lucide:file-check-2',
  bypassPermissions: 'i-lucide:shield-off',
  plan: 'i-lucide:clipboard-list',
};

/* 菜单第二行解释(安全语义区,光看标题不够):每档说清它实际放行什么。 */
const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: '编辑文件和使用互联网时始终询问',
  acceptEdits: '仅对检测到的风险操作请求批准',
  bypassPermissions: '可不受限制地访问互联网和电脑上的任何文件',
  plan: '仅使用只读工具调查和规划, 不实施修改; 切换在下一轮生效',
};

export function SessionModeSelector({
  value,
  onChange,
}: {
  value: SessionMode;
  onChange(value: SessionMode): void;
}): JSX.Element {
  const items = (): MenuItem[] => (['chat', 'work'] as const).map((mode) => ({
    kind: 'item',
    label: SESSION_MODE_LABELS[mode],
    icon: value === mode
      ? 'i-lucide:check'
      : SESSION_MODE_ICONS[mode],
    onSelect: () => onChange(mode),
  }));

  return (
    <DropdownMenu
      side="top"
      align="end"
      widthClass="min-w-36"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className="ema-chat-btn"
        >
          {SESSION_MODE_LABELS[value]}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

export function PermissionModeSelector({
  value,
  planUnavailableReason,
  onChange,
}: {
  value: PermissionMode;
  planUnavailableReason?: string;
  onChange(value: PermissionMode): void;
}): JSX.Element {
  // 各档权限有对应图标, 菜单与当前按钮共用同一映射.
  const items = (): MenuItem[] => (['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const).map((mode) => ({
    kind: 'item',
    label: PERMISSION_MODE_LABELS[mode],
    description: mode === 'plan' && planUnavailableReason
      ? planUnavailableReason : PERMISSION_MODE_DESCRIPTIONS[mode],
    disabled: mode === 'plan' && !!planUnavailableReason,
    icon: value === mode ? 'i-lucide:check' : PERMISSION_MODE_ICONS[mode],
    onSelect: () => onChange(mode),
  }));

  return (
    <DropdownMenu
      side="top"
      align="start"
      widthClass="min-w-64"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className={`ema-chat-btn ${
            value === 'bypassPermissions'
              ? 'text-[var(--ema-warning)]'
              : ''
          }`}
        >
          <span className={`${PERMISSION_MODE_ICONS[value]} text-sm`} aria-hidden />
          {PERMISSION_MODE_LABELS[value]}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

export function useInputOptions(
  viewedId: string | null,
  draft: ChatDraft,
  patchCurrentDraft: (patch: Partial<ChatDraft>) => void,
  planUnavailableReason: string | undefined,
  onPlanConflict: () => void,
  onPickAttachments: () => Promise<void>,
) {
  function showSessionPreferenceError(error: unknown): void {
    if (error instanceof ServerApiError && error.code === 'session_plan_goal_conflict') {
      showToast('请先关闭当前 Goal, 暂停目标仍不能开启 Plan', { variant: 'warning' });
      onPlanConflict();
      return;
    }
    showToast(
      error instanceof Error ? `保存会话设置失败: ${error.message}` : '保存会话设置失败',
      { variant: 'danger' },
    );
  }

  function toggleTts(): void {
    if (viewedId) {
      void useSessionStore.getState()
        .setTtsEnabled(viewedId, !draft.ttsEnabled)
        .catch(showSessionPreferenceError);
    } else {
      patchCurrentDraft({ ttsEnabled: !draft.ttsEnabled });
    }
  }

  function choosePermissionMode(permissionMode: PermissionMode): void {
    if (permissionMode === 'plan' && planUnavailableReason) {
      showToast(planUnavailableReason, { variant: 'warning' });
      return;
    }
    if (viewedId) {
      void useSessionStore.getState()
        .setPermissionMode(viewedId, permissionMode)
        .catch(showSessionPreferenceError);
    } else {
      patchCurrentDraft({ permissionMode });
    }
  }

  function chooseSessionMode(sessionMode: SessionMode): void {
    if (viewedId) {
      void useSessionStore.getState()
        .setSessionMode(viewedId, sessionMode)
        .catch(showSessionPreferenceError);
    } else {
      patchCurrentDraft({ sessionMode });
    }
  }

  const plusItems = (): MenuItem[] => [
    {
      kind: 'item',
      id: 'add:attachment',
      label: '添加文件或图片',
      icon: 'i-lucide:paperclip',
      onSelect: () => void onPickAttachments(),
    },
  ];

  return { plusItems, toggleTts, choosePermissionMode, chooseSessionMode };
}

export function TtsButton({ enabled, onToggle }: {
  enabled: boolean;
  onToggle(): void;
}): JSX.Element {
  return (
    <IconButton
      size="sm"
      icon={enabled ? 'i-lucide:volume-2' : 'i-lucide:volume-x'}
      label="切换 TTS"
      toggled={enabled}
      className="ema-chat-icon-btn"
      onClick={onToggle}
    />
  );
}
