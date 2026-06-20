import { useState, useCallback, type JSX } from 'react';
import { DropdownMenu, Input, type MenuItem } from '@ema-agent/ui';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import type { SessionWire } from '../api/sessions.js';
import type { SessionId } from '@ema-agent/contracts';

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
    <div className="relative shrink-0 border-b border-neutral-800">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-neutral-900 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className="text-sm font-medium text-neutral-200 truncate">
          {activeSession?.title ?? '新对话'}
        </span>
        <span className="i-mdi:chevron-down text-neutral-500 text-base ml-2" aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 z-50 bg-neutral-900 border border-neutral-700 rounded-b-xl shadow-2xl max-h-80 overflow-hidden flex flex-col">
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
                <div className="text-center text-neutral-500 text-sm py-4">
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
                className="w-full px-3 py-2 mt-1 rounded-lg text-sm text-primary-300 hover:bg-primary-400/10 transition-colors text-left"
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
        className="flex items-center gap-1 px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300 w-full text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`i-mdi:chevron-right text-sm transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
        {label}
        <span className="text-neutral-600 ml-1">({sessions.length})</span>
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

function WorkspaceEditor({ session, onClose }: { session: SessionWire; onClose(): void }): JSX.Element {
  const [paths, setPaths] = useState<string[]>(session.workspaceRoots ?? []);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  function addPath(): void {
    const p = input.trim();
    if (!p || paths.includes(p)) return;
    setPaths([...paths, p]);
    setInput('');
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await useSessionStore.getState().setWorkspaceRoots(session.id as SessionId, paths);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="absolute right-0 top-6 z-50 bg-neutral-800 border border-neutral-600 rounded-xl p-3 shadow-xl w-72"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs text-neutral-400 mb-2 font-medium">工作区目录</p>
      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && <p className="text-xs text-neutral-500 py-1">暂无工作区</p>}
        {paths.map((p) => (
          <div key={p} className="flex items-center justify-between bg-neutral-900 rounded-lg px-2 py-1 gap-2">
            <span className="text-xs text-neutral-300 font-mono truncate flex-1" title={p}>{p}</span>
            <button
              className="text-neutral-500 hover:text-red-400 shrink-0"
              onClick={() => setPaths(paths.filter((x) => x !== p))}
            >
              <span className="i-mdi:close text-sm" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-1 mb-3">
        <Input
          inputSize="sm"
          className="font-mono"
          placeholder="D:\path\to\project"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
        />
        <button
          className="px-2 rounded-md bg-neutral-700 text-neutral-300 text-xs hover:bg-neutral-600"
          onClick={addPath}
        >+</button>
      </div>
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg bg-primary-500/20 text-primary-200 text-xs hover:bg-primary-500/30 transition-colors disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >{saving ? '保存中…' : '保存'}</button>
        <button
          className="px-3 py-1.5 rounded-lg text-neutral-400 text-xs hover:text-neutral-200"
          onClick={onClose}
        >取消</button>
      </div>
    </div>
  );
}

// ── SessionRow ────────────────────────────────────────────────────────────────

function SessionRow({ session, isActive, onSelect }: {
  session: SessionWire; isActive: boolean; onSelect(): void;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消固定' : '固定',
      icon:     session.pinned ? 'i-mdi:pin-off-outline' : 'i-mdi:pin-outline',
      onSelect: () => void useSessionStore.getState().pinSession(session.id as SessionId, !session.pinned),
    },
    {
      kind:     'item',
      label:    '重命名',
      icon:     'i-mdi:pencil-outline',
      onSelect: () => {
        const name = prompt('新名称', session.title);
        if (name) void useSessionStore.getState().renameSession(session.id as SessionId, name);
      },
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
      onSelect: () => {
        const label = prompt('分组名称（留空取消分组）', session.groupLabel ?? '');
        if (label !== null) void useSessionStore.getState().setSessionGroup(session.id as SessionId, label.trim() || null);
      },
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
      onSelect: () => void useSessionStore.getState().archiveSession(session.id as SessionId),
    },
    { kind: 'separator' },
    {
      kind:     'item',
      label:    '删除',
      icon:     'i-mdi:delete-outline',
      danger:   true,
      onSelect: () => {
        if (confirm('确定删除这个会话？')) {
          void (async () => {
            await useSessionStore.getState().deleteSession(session.id as SessionId);
            useConversationStore.getState().evictSession(session.id as SessionId);
          })();
        }
      },
    },
  ];

  return (
    <div
      className={`group flex items-center justify-between px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors ${
        isActive ? 'bg-primary-500/15 text-primary-200' : 'text-neutral-300 hover:bg-neutral-800'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 truncate min-w-0">
        {session.pinned && (
          <span className="i-mdi:pin text-xs text-primary-400 shrink-0" aria-hidden />
        )}
        <span className="truncate">{session.title || '新对话'}</span>
        {session.runningTurnCount > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse shrink-0" aria-hidden />
        )}
      </div>

      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu
          trigger={
            <button className="opacity-0 group-hover:opacity-100 px-1 text-neutral-500 hover:text-neutral-200 rounded">
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
            <WorkspaceEditor session={session} onClose={() => setShowWorkspace(false)} />
          </>
        )}
      </div>
    </div>
  );
}
