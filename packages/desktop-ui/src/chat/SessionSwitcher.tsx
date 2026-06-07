import { useState, useCallback, type JSX } from 'react';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import type { SessionWire } from '../api/sessions.js';
import type { SessionId } from '@ema-agent/contracts';

export function SessionSwitcher(): JSX.Element {
  const sessions  = useSessionStore((s) => s.sessions);
  const viewedId  = useConversationStore((s) => s.viewedSessionId);
  const [open, setOpen]     = useState(false);
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
    <div className="relative flex-shrink-0 border-b border-gray-800">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-900 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className="text-sm font-medium text-gray-200 truncate">
          {activeSession?.title ?? '新对话'}
        </span>
        <span className="text-gray-500 text-xs ml-2">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 z-50 bg-gray-900 border border-gray-700 rounded-b-2xl shadow-2xl max-h-80 overflow-hidden flex flex-col">
            <div className="p-2">
              <input
                className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-pink-400/50"
                placeholder="搜索会话…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>

            <div className="overflow-y-auto flex-1 px-1 pb-1">
              {!hasResults && (
                <div className="text-center text-gray-500 text-sm py-4">
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
                className="w-full px-3 py-2 mt-1 rounded-xl text-sm text-pink-300 hover:bg-pink-400/10 transition-colors text-left"
                onClick={async () => {
                  const newId = await useSessionStore.getState().createSession();
                  if (newId) void useConversationStore.getState().viewSession(newId);
                  setOpen(false);
                }}
              >
                + 新建会话
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

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
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 w-full text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-[10px]">{collapsed ? '▶' : '▼'}</span>
        {label}
        <span className="text-gray-600">({sessions.length})</span>
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
      className="absolute right-0 top-6 z-50 bg-gray-800 border border-gray-600 rounded-xl p-3 shadow-xl w-72"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs text-gray-400 mb-2 font-medium">工作区目录</p>
      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && <p className="text-xs text-gray-500 py-1">暂无工作区</p>}
        {paths.map((p) => (
          <div key={p} className="flex items-center justify-between bg-gray-900 rounded-lg px-2 py-1 gap-2">
            <span className="text-xs text-gray-300 font-mono truncate flex-1" title={p}>{p}</span>
            <button className="text-gray-500 hover:text-red-400 text-xs flex-shrink-0" onClick={() => setPaths(paths.filter((x) => x !== p))}>✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-1 mb-3">
        <input
          className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-pink-400/50"
          placeholder="D:\path\to\project"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
        />
        <button className="px-2 py-1.5 rounded-lg bg-gray-700 text-gray-300 text-xs hover:bg-gray-600" onClick={addPath}>+</button>
      </div>
      <div className="flex gap-2">
        <button className="px-3 py-1.5 rounded-lg bg-pink-400/20 text-pink-300 text-xs hover:bg-pink-400/30 transition-colors disabled:opacity-50" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        <button className="px-3 py-1.5 rounded-lg text-gray-400 text-xs hover:text-gray-200" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

function SessionRow({ session, isActive, onSelect }: {
  session: SessionWire; isActive: boolean; onSelect(): void;
}): JSX.Element {
  const [menu, setMenu]               = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);

  return (
    <div
      className={`group flex items-center justify-between px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors ${
        isActive ? 'bg-pink-400/15 text-pink-200' : 'text-gray-300 hover:bg-gray-800'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 truncate">
        {session.pinned && <span className="text-xs text-pink-400">📌</span>}
        <span className="truncate">{session.title || '新对话'}</span>
        {session.runningTurnCount > 0 && (
          <span className="w-2 h-2 rounded-full bg-pink-400 animate-pulse flex-shrink-0" />
        )}
      </div>

      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          className="opacity-0 group-hover:opacity-100 px-1 text-gray-500 hover:text-gray-200 text-xs"
          onClick={() => { setMenu(!menu); setShowWorkspace(false); }}
        >⋯</button>

        {showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setShowWorkspace(false)} />
            <WorkspaceEditor session={session} onClose={() => setShowWorkspace(false)} />
          </>
        )}

        {menu && !showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setMenu(false)} />
            <div className="absolute right-0 top-6 z-50 bg-gray-800 border border-gray-600 rounded-xl py-1 shadow-xl min-w-28">
              <MenuItem label="📌 固定" onClick={() => {
                void useSessionStore.getState().pinSession(session.id as SessionId, !session.pinned);
                setMenu(false);
              }} />
              <MenuItem label="✏️ 重命名" onClick={() => {
                const name = prompt('新名称', session.title);
                if (name) void useSessionStore.getState().renameSession(session.id as SessionId, name);
                setMenu(false);
              }} />
              <MenuItem label="🔀 Fork" onClick={() => {
                void (async () => {
                  const newId = await useSessionStore.getState().forkSession(session.id as SessionId);
                  void useConversationStore.getState().viewSession(newId);
                })();
                setMenu(false);
              }} />
              <MenuItem label="🏷️ 分组" onClick={() => {
                const label = prompt('分组名称（留空取消分组）', session.groupLabel ?? '');
                if (label !== null) void useSessionStore.getState().setSessionGroup(session.id as SessionId, label.trim() || null);
                setMenu(false);
              }} />
              <MenuItem label="📁 工作区" onClick={() => { setMenu(false); setShowWorkspace(true); }} />
              <MenuItem label="📦 归档" onClick={() => {
                void useSessionStore.getState().archiveSession(session.id as SessionId);
                setMenu(false);
              }} />
              <MenuItem label="🗑️ 删除" danger onClick={() => {
                if (confirm('确定删除这个会话？')) {
                  void (async () => {
                    await useSessionStore.getState().deleteSession(session.id as SessionId);
                    useConversationStore.getState().evictSession(session.id as SessionId);
                  })();
                }
                setMenu(false);
              }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick(): void }): JSX.Element {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
        danger ? 'text-red-300 hover:bg-red-500/20' : 'text-gray-300 hover:bg-gray-700'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
