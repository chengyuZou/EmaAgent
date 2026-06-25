import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX, type ChangeEvent } from 'react';
import { IconButton, Input } from '@ema-agent/ui';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { useKbStore } from '../stores/kb-store.js';
import { ModeSelector } from './ModeSelector.js';
import { ModelPicker, type ModelSelection } from './ModelPicker.js';
import { AttachmentChip } from './AttachmentChip.js';
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
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);
  const prevViewedIdRef = useRef(viewedId);
  const TEXTAREA_MAX_H  = 200; // px — beyond this the textarea scrolls

  useEffect(() => {
    if (prevViewedIdRef.current === viewedId) return;
    prevViewedIdRef.current = viewedId;
    setText(useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '');
    setSelectedKbIds([]);  // KB selection is per-session; reset when switching sessions
  }, [viewedId]);

  // Auto-resize textarea height based on content, capped at TEXTAREA_MAX_H.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`;
  }, [text]);

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
      providerId: selectedModel?.providerId,
      model:      selectedModel?.model,
      ttsEnabled,
      // KB scope applies to agent mode only (no tool loop in chat/narrative).
      // Selection persists across sends so each send bumps the docs' use-count.
      kbAssetIds: mode === 'agent' && selectedKbIds.length > 0 ? selectedKbIds : undefined,
    });
    setText('');
    setPendingAttachments([]);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, '');
  }, [canSend, mode, text, pendingAttachments, ttsEnabled, viewedId, selectedKbIds]);

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
    <div className="shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--ema-border)' }}>
      <div className="max-w-2xl mx-auto">
        {/* ── Unified input box ── */}
        <div className="relative rounded-2xl" style={{ background: 'var(--ema-surface-2)' }}>
          {/* Always-pulsing pink glow ring */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none animate-pulse"
               style={{ boxShadow: '0 0 0 1.5px var(--ema-glow-strong), 0 0 20px var(--ema-glow)' }} />

          {/* Attachment strip (top half, shown only when files queued) */}
          {pendingAttachments.length > 0 && (
            <>
              <div className="relative px-3 pt-3 pb-2 flex flex-wrap gap-1.5">
                {pendingAttachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    attachment={a}
                    onRemove={() => removeAttachment(a.id)}
                  />
                ))}
              </div>
              {/* Fully transparent divider — just a hairline to separate regions */}
              <div className="mx-4 border-t border-white/[0.05]" />
            </>
          )}

          {/* Textarea + send button (bottom half) */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              className="relative w-full bg-transparent rounded-2xl px-4 py-3 pr-12 text-sm resize-none focus:outline-none overflow-y-auto"
              style={{ color: 'var(--ema-text-secondary)', minHeight: 60, maxHeight: TEXTAREA_MAX_H }}
              rows={1}
              placeholder="输入消息…"
              value={text}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
            />
            <div className="absolute right-2 bottom-2">
              {embeddedAction}
            </div>
          </div>
        </div>

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
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none"
                      style={{ background: 'var(--ema-primary)', color: 'var(--ema-text-primary)' }}>
                  {pendingAttachments.length}
                </span>
              )}
            </div>

            {mode === 'agent' && (
              <KbButton selectedIds={selectedKbIds} onChange={setSelectedKbIds} />
            )}

            <IconButton
              variant={ttsEnabled ? 'primary' : 'default'}
              size="sm"
              label="切换 TTS"
              icon="i-mdi:volume-high"
              toggled={ttsEnabled}
              onClick={() => useUiStore.getState().setTtsEnabled(!ttsEnabled)}
            />

            <ModelPicker
              selected={selectedModel}
              onSelect={setSelectedModel}
              onClear={() => setSelectedModel(null)}
            />

            <ModeSelector
              mode={mode}
              onModeChange={(m) => {
                if (viewedId) void useSessionStore.getState().setSessionMode(viewedId, m as TurnMode);
              }}
            />
          </div>

          {hasAnyStreaming && (
            <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--ema-text-tertiary)' }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--ema-primary)' }} aria-hidden />
              {isStreamingHere ? '生成中…' : '其他会话生成中'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── KbButton ──────────────────────────────────────────────────────────────────
// Agent-mode knowledge-base picker: select uploaded documents to scope kb_search.

function KbButton({
  selectedIds, onChange,
}: {
  selectedIds: string[]; onChange(ids: string[]): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <IconButton
        variant={selectedIds.length > 0 ? 'primary' : 'default'}
        size="sm"
        icon="i-solar:database-bold"
        label={selectedIds.length > 0 ? `知识库 (${selectedIds.length})` : '选择知识库'}
        toggled={selectedIds.length > 0}
        onClick={() => setOpen((v) => !v)}
      />
      {selectedIds.length > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none"
              style={{ background: 'var(--ema-primary)', color: 'var(--ema-text-primary)' }}>
          {selectedIds.length}
        </span>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <KbSelector
            selectedIds={selectedIds}
            onChange={onChange}
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}

// ── KbSelector ────────────────────────────────────────────────────────────────

function KbSelector({
  selectedIds, onChange, onClose,
}: {
  selectedIds: string[]; onChange(ids: string[]): void; onClose(): void;
}): JSX.Element {
  const documents = useKbStore((s) => s.documents);
  const loading   = useKbStore((s) => s.loading);

  useEffect(() => {
    void useKbStore.getState().loadDocuments();
  }, []);

  function toggle(id: string): void {
    onChange(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  }

  return (
    <div
      className="ema-slide-up absolute bottom-full left-0 mb-2 z-50 rounded-xl p-3 shadow-[var(--ema-shadow-2)] w-72"
      style={{ background: 'var(--ema-surface-4)', border: '1px solid var(--ema-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium" style={{ color: 'var(--ema-text-secondary)' }}>选择知识库文档</p>
        {selectedIds.length > 0 && (
          <button
            className="text-xs transition-colors"
            style={{ color: 'var(--ema-text-tertiary)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-primary)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-tertiary)'; }}
            onClick={() => onChange([])}
          >清空</button>
        )}
      </div>

      <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
        {loading ? (
          <p className="text-xs py-2 text-center" style={{ color: 'var(--ema-text-tertiary)' }}>加载中…</p>
        ) : documents.length === 0 ? (
          <p className="text-xs py-2 text-center" style={{ color: 'var(--ema-text-tertiary)' }}>暂无文档，去设置 → 知识库上传</p>
        ) : (
          documents.map((doc) => {
            const checked = selectedIds.includes(doc.id);
            return (
              <button
                key={doc.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
                style={{ background: checked ? 'var(--ema-primary-muted)' : 'var(--ema-surface-2)' }}
                onClick={() => toggle(doc.id)}
              >
                <span
                  className={`text-sm shrink-0 ${checked ? 'i-mdi:checkbox-marked' : 'i-mdi:checkbox-blank-outline'}`}
                  style={{ color: checked ? 'var(--ema-primary)' : 'var(--ema-text-tertiary)' }}
                  aria-hidden
                />
                <span className="text-xs truncate flex-1"
                      style={{ color: 'var(--ema-text-secondary)' }} title={doc.fileName}>
                  {doc.fileName}
                </span>
                {doc.status !== 'indexed' && (
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--ema-text-tertiary)' }}>
                    {doc.status === 'error' ? '错误' : '索引中'}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="flex justify-end mt-3">
        <button
          className="px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{ background: 'var(--ema-primary-muted)', color: 'var(--ema-primary)' }}
          onClick={onClose}
        >完成</button>
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
      className="ema-slide-up absolute bottom-full left-0 mb-2 z-50 rounded-xl p-3 shadow-[var(--ema-shadow-2)] w-72"
      style={{ background: 'var(--ema-surface-4)', border: '1px solid var(--ema-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs mb-2 font-medium" style={{ color: 'var(--ema-text-secondary)' }}>工作区目录</p>

      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && (
          <p className="text-xs py-1" style={{ color: 'var(--ema-text-tertiary)' }}>暂无工作区(使用 sidecar 启动目录)</p>
        )}
        {paths.map((p) => (
          <div key={p} className="flex items-center justify-between rounded-lg px-2 py-1 gap-2"
               style={{ background: 'var(--ema-surface-2)' }}>
            <span className="text-xs font-mono truncate flex-1" style={{ color: 'var(--ema-text-secondary)' }} title={p}>{p}</span>
            <button
              style={{ color: 'var(--ema-text-tertiary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-danger)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-tertiary)'; }}
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
          className="px-2 rounded-md text-xs transition-colors text-[var(--ema-text-secondary)] bg-[var(--ema-surface-3)] hover:bg-[var(--ema-surface-2)]"
          onClick={addPath}
        >+</button>
      </div>

      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50"
          style={{ background: 'var(--ema-primary-muted)', color: 'var(--ema-primary)' }}
          disabled={saving}
          onClick={() => void save()}
        >{saving ? '保存中…' : '保存'}</button>
        <button
          className="px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{ color: 'var(--ema-text-tertiary)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ema-text-primary)'; }}
          onClick={onClose}
        >取消</button>
      </div>
    </div>
  );
}
