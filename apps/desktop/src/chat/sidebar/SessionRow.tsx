// 侧栏单条会话行:状态点、标题、时间与右键菜单操作,含删除/重命名确认。
import { useState, type JSX } from 'react';
import { Button, ConfirmDialog, DropdownMenu, IconButton, Input, PromptDialog, type MenuItem } from '@ema-agent/ui';
import type { SessionListItem } from '../../api/sessions.js';
import type { AgentSessionState } from '../../stores/agent.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { useSessionStore } from '../../stores/session.js';
import { runWithToast } from '../../lib/toast.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

type StatusDot = { cls: string } | null;

export function getStatusDot(
  session: SessionListItem,
  agentSessions: ReadonlyMap<string, AgentSessionState>,
): StatusDot {
  const state = agentSessions.get(session.id);
  if (state?.execution) return { cls: 'bg-[var(--ema-info)] animate-pulse' };
  if ((state?.pendingInteractions.length ?? 0) > 0) return { cls: 'bg-[var(--ema-warning)] animate-pulse' };
  if (session.lastTurnStatus === 'failed' || session.lastTurnStatus === 'aborted') {
    return { cls: 'bg-[var(--ema-danger)]' };
  }
  if (session.hasUnread) return { cls: 'bg-[var(--ema-success)]' };
  return null;
}

export function formatRelativeTime(updatedAt: number): string {
  const diff = Math.max(0, Date.now() - updatedAt);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 604_800_000)}周前`;
  return `${Math.floor(diff / 2_592_000_000)}月前`;
}

export function projectLabelFor(session: SessionListItem): string {
  if (!session.workspaceRoot) return '对话';
  const parts = session.workspaceRoot.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? session.workspaceRoot;
}

export function SessionRow({ session, isActive, agentSessions, nested = false }: {
  session:   SessionListItem;
  isActive:  boolean;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
  nested?:   boolean;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [promptRename, setPromptRename] = useState(false);
  const dot = getStatusDot(session, agentSessions);
  const agentSession = agentSessions.get(session.id);
  const isRunning = agentSession?.execution != null;
  const timeLabel = formatRelativeTime(session.lastActivityAt);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消置顶' : '置顶',
      icon:     session.pinned ? 'i-lucide:pin-off' : 'i-lucide:pin',
      onSelect: () => void runWithToast(useSessionStore.getState().pinSession(session.id, !session.pinned), '对话置顶失败'),
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
        void useChatWorkspace.getState().viewSession(newId);
      })(),
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
      onClick={() => void useChatWorkspace.getState().viewSession(session.id)}
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
        {(agentSession?.pendingInteractions.length ?? 0) > 0 && (
          <span
            className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full ema-scale-in bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)]"
            title={`${agentSession?.pendingInteractions.length ?? 0} 个待答问题`}
          >
            {agentSession?.pendingInteractions.length}
          </span>
        )}
      </div>

      <div
        className="relative flex w-12 shrink-0 justify-end"
        onClick={(event) => event.stopPropagation()}
      >
        <span
          className={`text-[11px] tabular-nums text-[var(--ema-text-tertiary)] transition-opacity ${
            isActive ? 'opacity-0' : 'group-hover:opacity-0'
          }`}
        >
          {timeLabel}
        </span>
        <DropdownMenu
          trigger={
            <Button
              variant="ghost"
              className={`absolute right-0 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded p-0 font-normal text-[var(--ema-text-tertiary)] transition-[opacity,color,background-color] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)] ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
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
            <WorkspacePicker session={session} onClose={() => setShowWorkspace(false)} />
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
        onConfirm={(name) => {
          setPromptRename(false);
          if (name) {
            void runWithToast(
              useSessionStore.getState().renameSession(session.id, name),
              '重命名失败',
            );
          }
        }}
        onCancel={() => setPromptRename(false)}
      />
    </div>
  );
}

function WorkspacePicker({
  session,
  onClose,
}: {
  session: SessionListItem;
  onClose(): void;
}): JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState(session.workspaceRoot ?? '');
  const [saving, setSaving] = useState(false);
  async function pick(): Promise<void> {
    const chosen = await tauriBridge.openFileDialog({ directory: true });
    if (chosen) setWorkspaceRoot(chosen);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await useSessionStore.getState().setWorkspaceRoot(
        session.id,
        workspaceRoot.trim() || null,
      );
      onClose();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '工作区设置失败',
        { variant: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="ema-slide-up absolute left-full top-0 z-50 ml-1 w-72 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-4)] p-3 shadow-[var(--ema-shadow-2)]"
      onClick={(event) => event.stopPropagation()}
    >
      <p className="mb-2 text-xs font-medium text-[var(--ema-text-secondary)]">
        工作区目录
      </p>
      <div className="mb-3 flex gap-1">
        <Input
          inputSize="sm"
          className="font-mono"
          placeholder="D:\\path\\to\\project"
          value={workspaceRoot}
          onChange={(event) => setWorkspaceRoot(event.target.value)}
          autoFocus
        />
        <IconButton
          size="sm"
          label="浏览"
          icon="i-lucide:folder-open"
          onClick={() => void pick()}
        />
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
