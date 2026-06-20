import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX } from 'react';
import { IconButton, Input } from '@ema-agent/ui';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { ModeSelector } from './ModeSelector.js';
import { showToast } from '../lib/toast.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { AttachmentInputWire } from '../api/turns.js';
import type { TurnMode, SessionId } from '@ema-agent/contracts';

// ── Attachment helpers ────────────────────────────────────────────────────────

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}

function pathToAttachment(localPath: string): AttachmentInputWire {
  const name = localPath.replace(/\\/g, '/').split('/').pop() ?? localPath;
  return {
    id:        crypto.randomUUID(),
    name,
    mimeType:  mimeFromName(name),
    size:      0,
    mtime:     0,
    localPath,
  };
}

export function ChatInput(): JSX.Element {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const ttsEnabled = useUiStore((s) => s.ttsEnabled);

  const initialDraft = useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '';
  const [text, setText] = useState(initialDraft);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentInputWire[]>([]);
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
  const mode = sessionMode?.mode ?? 'chat';

  const hasAnyStreaming  = useConversationStore((s) => s.streamingMap.size > 0);
  const isStreamingHere = useConversationStore((s) =>
    viewedId ? s.streamingMap.has(viewedId as string) : false,
  );
  const canSend = text.trim().length > 0 && !isStreamingHere;

  function handleChange(value: string): void {
    setText(value);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, value);
  }

  async function pickAttachment(): Promise<void> {
    const localPath = await tauriBridge.openFileDialog();
    if (!localPath) return;
    setPendingAttachments((prev) => [...prev, pathToAttachment(localPath)]);
  }

  function removeAttachment(id: string): void {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const send = useCallback(() => {
    if (!canSend) return;
    void useConversationStore.getState().sendMessage(viewedId, {
      mode,
      text: text.trim(),
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      ttsEnabled,
    });
    setText('');
    setPendingAttachments([]);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, '');
  }, [canSend, mode, text, pendingAttachments, ttsEnabled, viewedId]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // The send/stop button rendered inside the Textarea's embeddedAction slot.
  const embeddedAction = isStreamingHere ? (
    <IconButton
      variant="danger"
      size="sm"
      label="停止生成"
      icon="i-mdi:stop"
      onClick={() => { if (viewedId) useConversationStore.getState().stopStreaming(viewedId); }}
    />
  ) : (
    <IconButton
      variant="primary"
      size="sm"
      label="发送"
      icon="i-mdi:send"
      onClick={send}
    />
  );

  return (
    <div className="shrink-0 border-t border-neutral-800 px-4 py-3">
      <div className="max-w-2xl mx-auto">
        {/* Main textarea with embedded send/stop button */}
        <div className="relative">
          {/* Always-pulsing pink glow ring — separate layer so pulse doesn't dim the text */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none animate-pulse shadow-[0_0_0_1.5px_rgba(244,114,182,0.45),0_0_20px_rgba(244,114,182,0.2)]" />
          <textarea
            className="relative w-full bg-neutral-800/80 border-0 rounded-2xl px-4 py-3 pr-12 text-sm text-neutral-200 resize-none focus:outline-none placeholder-neutral-500 transition-colors"
            rows={3}
            placeholder="输入消息…"
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />
          <div className="absolute right-2 bottom-2">
            {embeddedAction}
          </div>
        </div>

        {/* Pending attachments preview strip */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {pendingAttachments.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-neutral-700/60 text-xs text-neutral-300 max-w-[180px]"
              >
                <span className="i-solar:document-bold text-neutral-400 shrink-0" aria-hidden />
                <span className="truncate" title={a.localPath}>{a.name}</span>
                <button
                  className="text-neutral-500 hover:text-red-400 shrink-0 ml-0.5"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`移除 ${a.name}`}
                >
                  <span className="i-mdi:close text-sm" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1">
            <WorkspaceButton sessionId={viewedId as string | null} />

            {/* Attachment picker */}
            <div className="relative">
              <IconButton
                variant={pendingAttachments.length > 0 ? 'primary' : 'default'}
                size="sm"
                label="添加附件"
                icon="i-mdi:paperclip"
                toggled={pendingAttachments.length > 0}
                onClick={() => void pickAttachment()}
              />
              {pendingAttachments.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-primary-500 text-[10px] text-white font-medium px-0.5 pointer-events-none">
                  {pendingAttachments.length}
                </span>
              )}
            </div>

            <IconButton
              variant={ttsEnabled ? 'primary' : 'default'}
              size="sm"
              label="切换 TTS"
              icon="i-mdi:volume-high"
              toggled={ttsEnabled}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
            />

            <ModeSelector
              mode={mode}
              onModeChange={(m) => {
                if (viewedId) void useSessionStore.getState().setSessionMode(viewedId, m as TurnMode);
              }}
            />
          </div>

          {hasAnyStreaming && (
            <div className="text-xs text-neutral-500 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" aria-hidden />
              {isStreamingHere ? '生成中…' : '其他会话生成中'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WorkspaceButton ───────────────────────────────────────────────────────────

function WorkspaceButton({ sessionId }: { sessionId: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const session = useSessionStore((s) =>
    sessionId ? s.sessions.byId.get(sessionId) : undefined,
  );
  const roots = session?.workspaceRoots ?? [];

  function handleClick(): void {
    if (!sessionId) {
      showToast('请先发送消息创建会话', { variant: 'warning' });
      return;
    }
    setOpen(!open);
  }

  return (
    <div className="relative">
      <IconButton
        variant={roots.length > 0 ? 'primary' : 'default'}
        size="sm"
        icon="i-mdi:folder-outline"
        label={roots.length > 0 ? `工作区目录 (${roots.length})` : '未设置工作区目录'}
        toggled={roots.length > 0}
        onClick={handleClick}
      />

      {open && sessionId && (
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
      className="absolute bottom-full left-0 mb-2 z-50 bg-neutral-800 border border-neutral-600 rounded-xl p-3 shadow-xl w-72"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs text-neutral-400 mb-2 font-medium">工作区目录</p>

      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && (
          <p className="text-xs text-neutral-500 py-1">暂无工作区（使用 sidecar 启动目录）</p>
        )}
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
          autoFocus
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
