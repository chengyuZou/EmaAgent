// 侧栏单条会话行:状态点、标题、时间与右键菜单操作,含删除/重命名/分组确认。
import { useState, type JSX } from 'react';
import { Button, ConfirmDialog, DropdownMenu, PromptDialog, type MenuItem } from '@ema-agent/ui';
import type { SessionWire } from '../../api/sessions.js';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { runWithToast } from '../../lib/toast.js';

import { WorkspacePicker } from '../WorkspacePicker.js';
import { formatRelativeTime } from './sidebarFormat.js';

type StatusDot = { cls: string } | null;

export function getStatusDot(
  session: SessionWire,
  streaming: Map<string, unknown>,
  pendingCounts: Record<string, number>,
): StatusDot {
  if (streaming.has(session.id)) return { cls: 'bg-[var(--ema-info)] animate-pulse' };
  if ((pendingCounts[session.id] ?? 0) > 0) return { cls: 'bg-[var(--ema-warning)] animate-pulse' };
  if (session.lastTurnStatus === 'failed' || session.lastTurnStatus === 'aborted') {
    return { cls: 'bg-[var(--ema-danger)]' };
  }
  if (session.hasUnread) return { cls: 'bg-[var(--ema-success)]' };
  return null;
}

export function SidebarRow({ session, isActive, streaming, pendingCounts, nested = false }: {
  session:   SessionWire;
  isActive:  boolean;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
  nested?:   boolean;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [promptRename, setPromptRename] = useState(false);
  const [promptGroup,  setPromptGroup]  = useState(false);
  const dot = getStatusDot(session, streaming, pendingCounts);
  const isRunning = streaming.has(session.id);
  const timeLabel = formatRelativeTime(session.lastActivityAt);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消固定' : '固定',
      icon:     session.pinned ? 'i-lucide:pin-off' : 'i-lucide:pin',
      onSelect: () => void runWithToast(useSessionStore.getState().pinSession(session.id, !session.pinned), '固定失败'),
    },
    {
      kind:     'item',
      label:    '重命名',
      icon:     'i-lucide:pencil',
      onSelect: () => setPromptRename(true),
    },
    {
      kind:     'item',
      label:    'Fork',
      icon:     'i-lucide:git-fork',
      onSelect: () => void (async () => {
        const newId = await useSessionStore.getState().forkSession(session.id);
        void useConversationStore.getState().viewSession(newId);
      })(),
    },
    {
      kind:     'item',
      label:    '设置分组',
      icon:     'i-lucide:tag',
      onSelect: () => setPromptGroup(true),
    },
    {
      kind:     'item',
      label:    '工作区目录',
      icon:     'i-lucide:folder',
      onSelect: () => setShowWorkspace(true),
    },
    {
      kind:     'item',
      label:    '归档',
      icon:     'i-lucide:archive',
      onSelect: () => void runWithToast(useSessionStore.getState().archiveSession(session.id), '归档失败'),
    },
    { kind: 'separator' },
    {
      kind:     'item',
      label:    '删除',
      icon:     'i-lucide:trash-2',
      danger:   true,
      onSelect: () => setPendingDelete(true),
    },
  ];

  function confirmDelete(): void {
    setPendingDelete(false);
    void runWithToast(useSessionStore.getState().deleteSession(session.id), '删除失败');
  }

  return (
    <div
      className={`group relative flex items-center gap-1.5 h-9 pr-2 rounded-md text-sm cursor-pointer transition-[background-color,color,box-shadow] duration-[var(--ema-duration-fast)] ease-[var(--ema-ease)] ${
        nested ? 'pl-6' : 'pl-2'
      } ${
        isActive
          ? 'ema-active-rail bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]'
          : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]'
      }`}
      onClick={() => void useConversationStore.getState().viewSession(session.id)}
    >
      <span className="shrink-0 w-3 flex items-center justify-center">
        {dot ? (
          <span className={`w-1.5 h-1.5 rounded-full ${dot.cls}`} />
        ) : isRunning ? (
          <span className="flex gap-px">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-0.5 h-0.5 rounded-full animate-pulse bg-[var(--ema-text-secondary)]"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full border ${isActive ? 'border-[var(--ema-text-tertiary)]' : 'border-[var(--ema-border)]'}`} />
        )}
      </span>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {session.pinned && (
          <span className={`i-lucide:pin text-[11px] shrink-0 ${isActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`} aria-hidden />
        )}
        <span className="truncate min-w-0 leading-snug">
          {session.title || '新对话'}
        </span>
        {(pendingCounts[session.id] ?? 0) > 0 && (
          <span
            className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full ema-scale-in bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)]"
            title={`${pendingCounts[session.id]} 个待答问题`}
          >
            {pendingCounts[session.id]}
          </span>
        )}
      </div>

      <div className="shrink-0 relative w-12 flex justify-end" onClick={(e) => e.stopPropagation()}>
        <span className={`text-[11px] tabular-nums transition-opacity text-[var(--ema-text-tertiary)] ${
          isActive ? 'opacity-0' : 'group-hover:opacity-0'
        }`}>
          {timeLabel}
        </span>
        <DropdownMenu
          trigger={
            <Button variant="ghost" className={`absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 p-0 flex items-center justify-center rounded transition-[opacity,color,background-color] text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)] font-normal ${
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}>
              <span className="i-solar:menu-dots-bold-duotone text-xs shrink-0" aria-hidden />
            </Button>
          }
          items={menuItems}
          side="right"
          align="start"
        />

        {showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setShowWorkspace(false)} />
            <WorkspacePicker session={session} positionClassName="left-full top-0 ml-1" onClose={() => setShowWorkspace(false)} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        message={`确定删除会话"${session.title || '新对话'}"？此操作不可撤销。`}
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(false)}
      />

      <PromptDialog
        open={promptRename}
        title="重命名会话"
        message="输入新的会话名称"
        initialValue={session.title}
        confirmText="重命名"
        onConfirm={(name) => { setPromptRename(false); if (name) void runWithToast(useSessionStore.getState().renameSession(session.id, name), '重命名失败'); }}
        onCancel={() => setPromptRename(false)}
      />

      <PromptDialog
        open={promptGroup}
        title="设置分组"
        message="输入分组名称(留空取消分组)"
        initialValue={session.groupLabel ?? ''}
        confirmText="保存"
        onConfirm={(label) => { setPromptGroup(false); void runWithToast(useSessionStore.getState().setSessionGroup(session.id, label.trim() || null), '分组失败'); }}
        onCancel={() => setPromptGroup(false)}
      />
    </div>
  );
}
