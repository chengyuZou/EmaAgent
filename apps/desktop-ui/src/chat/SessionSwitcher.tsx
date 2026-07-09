import { useState, useCallback, type JSX } from 'react';
import { ConfirmDialog, DropdownMenu, Input, PromptDialog, type MenuItem } from '@ema-agent/ui';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { runWithToast } from '../lib/toast.js';
import type { SessionWire } from '../api/sessions.js';
import type { SessionId } from '@ema-agent/contracts';
import { WorkspacePicker } from './WorkspacePicker.js';

export function SessionSwitcher(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState('');

  const activeSession = viewedId ? sessions.byId.get(viewedId as string) : null;

  const filter = useCallback(
    (s: SessionWire) =>
      !search ||
      s.title.toLowerCase().includes(search.toLowerCase()) ||
      (s.groupLabel ?? '').toLowerCase().includes(search.toLowerCase()),
    [search],
  );

  const filteredPinned   = sessions.pinned.filter(filter);
  const filteredRecent   = sessions.recent.filter(filter);
  const filteredArchived = sessions.archived.filter(filter);
  const filteredGroups   = sessions.byGroup
    .map((g) => ({ ...g, sessions: g.sessions.filter(filter) }))
    .filter((g) => g.sessions.length > 0);

  const hasResults =
    filteredPinned.length > 0 || filteredRecent.length > 0 ||
    filteredGroups.length > 0 || filteredArchived.length > 0;

  return (
    <div className="relative shrink-0 border-b border-[var(--ema-border)]">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 transition-colors text-[var(--ema-text-secondary)]"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ema-surface-2)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
        onClick={() => setOpen(!open)}
      >
        <span className="text-sm font-medium truncate">{activeSession?.title ?? '新对话'}</span>
        <span className="i-mdi:chevron-down text-base ml-2 text-[var(--ema-text-tertiary)]" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="ema-slide-up absolute top-full left-0 right-0 z-50 rounded-b-xl max-h-80 overflow-hidden flex flex-col shadow-[var(--ema-shadow-3)] bg-[var(--ema-surface-4)]"
               style={{ border: '1px solid var(--ema-border)' }}>
            <div className="p-2">
              <Input
                inputSize="sm"
                placeholder="搜索会话…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>

            <div className="overflow-y-auto flex-1 px-1 pb-1">
              {!hasResults && (
                <div className="text-center text-sm py-4 text-[var(--ema-text-tertiary)]">
                  暂无会话，发消息自动创建
                </div>
              )}

              {filteredPinned.length > 0 && (
                <Section label="已固定" sessions={filteredPinned} viewedId={viewedId} onClose={() => setOpen(false)} />
              )}
              {filteredGroups.map((g) => (
                <Section key={g.label} label={g.label} sessions={g.sessions} viewedId={viewedId} onClose={() => setOpen(false)} />
              ))}
              {filteredRecent.length > 0 && (
                <Section label="最近" sessions={filteredRecent} viewedId={viewedId} onClose={() => setOpen(false)} />
              )}
              {filteredArchived.length > 0 && (
                <Section label="已归档" sessions={filteredArchived} viewedId={viewedId} collapsed onClose={() => setOpen(false)} />
              )}

              <button
                className="ema-stagger-in w-full px-3 py-2 mt-1 rounded-lg text-sm transition-colors text-left text-[var(--ema-primary)]"
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ema-primary-muted)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                onClick={async () => {
                  const newId = await useSessionStore.getState().createSession();
                  if (newId) void useConversationStore.getState().viewSession(newId);
                  setOpen(false);
                }}
              >
                <span className="i-mdi:plus text-base mr-1" aria-hidden />
                新建会话
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section({
  label, sessions, viewedId, collapsed: initCollapsed = false, onClose,
}: {
  label: string; sessions: SessionWire[]; viewedId: SessionId | null;
  collapsed?: boolean; onClose(): void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(initCollapsed);

  return (
    <div className="mb-1">
      <button
        className="flex items-center gap-1 px-2 py-1 text-xs w-full text-left transition-colors text-[var(--ema-text-tertiary)]"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-primary)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-tertiary)'; }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`i-mdi:chevron-right text-sm transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
        {label}
        <span className="ml-1 text-[var(--ema-text-tertiary)]">({sessions.length})</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              isActive={s.id === (viewedId as string)}
              onSelect={() => {
                void useConversationStore.getState().viewSession(s.id as SessionId);
                onClose();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── WorkspaceEditor ───────────────────────────────────────────────────────────
// (removed — replaced by the shared WorkspacePicker component)


// ── SessionRow ────────────────────────────────────────────────────────────────

function SessionRow({ session, isActive, onSelect }: {
  session: SessionWire; isActive: boolean; onSelect(): void;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [promptRename, setPromptRename] = useState(false);
  const [promptGroup,  setPromptGroup]  = useState(false);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消固定' : '固定',
      icon:     session.pinned ? 'i-mdi:pin-off-outline' : 'i-mdi:pin-outline',
      onSelect: () => void runWithToast(useSessionStore.getState().pinSession(session.id as SessionId, !session.pinned), '固定失败'),
    },
    {
      kind:     'item',
      label:    '重命名',
      icon:     'i-mdi:pencil-outline',
      onSelect: () => setPromptRename(true),
    },
    {
      kind:     'item',
      label:    'Fork',
      icon:     'i-mdi:source-fork',
      onSelect: () => void (async () => {
        const newId = await useSessionStore.getState().forkSession(session.id as SessionId);
        void useConversationStore.getState().viewSession(newId);
      })(),
    },
    {
      kind:     'item',
      label:    '设置分组',
      icon:     'i-mdi:tag-outline',
      onSelect: () => setPromptGroup(true),
    },
    {
      kind:     'item',
      label:    '工作区目录',
      icon:     'i-mdi:folder-outline',
      onSelect: () => setShowWorkspace(true),
    },
    {
      kind:     'item',
      label:    '归档',
      icon:     'i-mdi:archive-outline',
      onSelect: () => void runWithToast(useSessionStore.getState().archiveSession(session.id as SessionId), '归档失败'),
    },
    { kind: 'separator' },
    {
      kind:     'item',
      label:    '删除',
      icon:     'i-mdi:delete-outline',
      danger:   true,
      onSelect: () => setPendingDelete(true),
    },
  ];

  function confirmDelete(): void {
    setPendingDelete(false);
    void runWithToast(useSessionStore.getState().deleteSession(session.id as SessionId), '删除失败');
  }

  return (
    <div
      className={`group flex items-center justify-between px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors ${
        isActive ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]' : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 truncate min-w-0">
        {session.pinned && (
          <span className="i-mdi:pin text-xs shrink-0 text-[var(--ema-primary)]" aria-hidden />
        )}
        <span className="truncate">{session.title || '新对话'}</span>
        {session.runningTurnCount > 0 && (
          <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0 bg-[var(--ema-primary)]" aria-hidden />
        )}
      </div>

      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu
          trigger={
            <button className="opacity-0 group-hover:opacity-100 px-1 rounded transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]">
              <span className="i-mdi:dots-horizontal text-base" aria-hidden />
            </button>
          }
          items={menuItems}
          side="bottom"
          align="end"
        />

        {showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setShowWorkspace(false)} />
            <WorkspacePicker session={session} positionClassName="right-0 top-6" onClose={() => setShowWorkspace(false)} />
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
        onConfirm={(name) => { setPromptRename(false); if (name) void runWithToast(useSessionStore.getState().renameSession(session.id as SessionId, name), '重命名失败'); }}
        onCancel={() => setPromptRename(false)}
      />

      <PromptDialog
        open={promptGroup}
        title="设置分组"
        message="输入分组名称(留空取消分组)"
        initialValue={session.groupLabel ?? ''}
        confirmText="保存"
        onConfirm={(label) => { setPromptGroup(false); void runWithToast(useSessionStore.getState().setSessionGroup(session.id as SessionId, label.trim() || null), '分组失败'); }}
        onCancel={() => setPromptGroup(false)}
      />
    </div>
  );
}
