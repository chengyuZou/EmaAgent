import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX } from 'react';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { ModeSelector } from './ModeSelector.js';
import type { TurnMode, AgentSubMode, SessionId } from '@ema-agent/contracts';

export function ChatInput(): JSX.Element {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const ttsEnabled = useUiStore((s) => s.ttsEnabled);

  // Draft: restore when viewedId changes, persist on every keystroke
  const initialDraft = useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '';
  const [text, setText] = useState(initialDraft);
  const prevViewedIdRef = useRef(viewedId);

  useEffect(() => {
    if (prevViewedIdRef.current === viewedId) return;
    prevViewedIdRef.current = viewedId;
    setText(useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '');
  }, [viewedId]);

  const [isComposing, setIsComposing] = useState(false);

  const sessionMode = useSessionStore((s) =>
    viewedId ? s.sessionModes.get(viewedId as string) : undefined,
  );
  const mode    = sessionMode?.mode    ?? 'chat';
  const subMode = sessionMode?.subMode ?? undefined;

  const hasAnyStreaming = useConversationStore((s) => s.streamingMap.size > 0);
  const isStreamingHere = useConversationStore((s) =>
    viewedId ? s.streamingMap.has(viewedId as string) : false,
  );
  const canSend = text.trim().length > 0 && !isStreamingHere;

  function handleChange(value: string): void {
    setText(value);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, value);
  }

  const send = useCallback(() => {
    if (!canSend) return;
    void useConversationStore.getState().sendMessage(viewedId, {
      mode,
      agentSubMode: subMode,
      text: text.trim(),
      ttsEnabled,
    });
    setText('');
    if (viewedId) useConversationStore.getState().setDraft(viewedId, '');
  }, [canSend, mode, subMode, text, ttsEnabled, viewedId]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex-shrink-0 border-t border-gray-800 px-4 py-3">
      <div className="max-w-2xl mx-auto">
        <div className="relative">
          <textarea
            className="w-full bg-gray-800 border border-gray-600 rounded-2xl px-4 py-3 pr-12 text-sm text-gray-200 resize-none focus:outline-none focus:border-pink-400/50 placeholder-gray-500"
            rows={3}
            placeholder="输入消息…"
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />

          {isStreamingHere ? (
            <button
              className="absolute right-2 bottom-2 w-8 h-8 rounded-full flex items-center justify-center bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
              onClick={() => { if (viewedId) useConversationStore.getState().stopStreaming(viewedId); }}
              aria-label="停止生成"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="1" y="1" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              className={`absolute right-2 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                canSend
                  ? 'bg-pink-400/20 text-pink-300 hover:bg-pink-400/30'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
              disabled={!canSend}
              onClick={send}
              aria-label="发送"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 8l14-7-7 14-2-7z" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            {viewedId && <WorkspaceButton sessionId={viewedId as string} />}

            <button
              className={`px-2 py-1 rounded-lg text-xs transition-colors ${
                ttsEnabled ? 'bg-pink-400/20 text-pink-300' : 'text-gray-500 hover:text-gray-300'
              }`}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
              aria-label="切换 TTS"
            >
              🔊
            </button>

            <ModeSelector
              mode={mode}
              subMode={subMode}
              onModeChange={(m, sm) => {
                if (viewedId) void useSessionStore.getState().setSessionMode(viewedId, m, sm);
              }}
            />
          </div>

          {hasAnyStreaming && (
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
              {isStreamingHere ? '生成中…' : '其他会话生成中'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WorkspaceButton ───────────────────────────────────────────────────────────

function WorkspaceButton({ sessionId }: { sessionId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const session = useSessionStore((s) => s.sessions.byId.get(sessionId));
  const roots   = session?.workspaceRoots ?? [];

  return (
    <div className="relative">
      <button
        className={`px-2 py-1 rounded-lg text-xs transition-colors ${
          roots.length > 0 ? 'bg-blue-400/20 text-blue-300 hover:bg-blue-400/30' : 'text-gray-500 hover:text-gray-300'
        }`}
        onClick={() => setOpen(!open)}
        aria-label="工作区目录"
        title={roots.length > 0 ? roots.join('\n') : '未设置工作区目录'}
      >
        📁{roots.length > 0 && <span className="ml-0.5">{roots.length}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <WorkspaceEditor
            sessionId={sessionId}
            initialRoots={roots}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}

// ── WorkspaceEditor ───────────────────────────────────────────────────────────

function WorkspaceEditor({
  sessionId, initialRoots, onClose,
}: {
  sessionId: string; initialRoots: string[]; onClose(): void;
}): JSX.Element {
  const [paths, setPaths] = useState<string[]>(initialRoots);
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
      await useSessionStore.getState().setWorkspaceRoots(sessionId as SessionId, paths);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="absolute bottom-full left-0 mb-2 z-50 bg-gray-800 border border-gray-600 rounded-xl p-3 shadow-xl w-72"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs text-gray-400 mb-2 font-medium">工作区目录</p>

      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && (
          <p className="text-xs text-gray-500 py-1">暂无工作区（使用 sidecar 启动目录）</p>
        )}
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
          autoFocus
        />
        <button className="px-2 py-1.5 rounded-lg bg-gray-700 text-gray-300 text-xs hover:bg-gray-600" onClick={addPath}>+</button>
      </div>

      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg bg-pink-400/20 text-pink-300 text-xs hover:bg-pink-400/30 transition-colors disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >{saving ? '保存中…' : '保存'}</button>
        <button className="px-3 py-1.5 rounded-lg text-gray-400 text-xs hover:text-gray-200" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
