import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX, type ChangeEvent } from 'react';
import { IconButton, Input, Button, Popover, Tooltip, TooltipProvider, Checkbox, ScrollArea, Spinner } from '@ema-agent/ui';
import { kbApi, type DocumentAssetWire } from '../api/knowledge-base.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useUiStore } from '../stores/ui-store.js';
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

            <KbButton visible={mode === 'agent'} selectedIds={selectedKbIds} onChange={setSelectedKbIds} />

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
// Appears/disappears with the agent mode toggle (ema-scale-in / ema-fade-out,
// delayed unmount so the exit keyframe plays). The panel is a Radix Popover
// (ema-anim-scale → both enter and exit animate, from style.css).

function KbButton({
  visible, selectedIds, onChange,
}: {
  visible: boolean; selectedIds: string[]; onChange(ids: string[]): void;
}): JSX.Element | null {
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen]       = useState(false);

  useEffect(() => {
    if (visible) { setMounted(true); return; }
    setOpen(false);  // close the panel before the button leaves
    const t = setTimeout(() => setMounted(false), 220);  // ≈ --ema-duration-base, lets ema-fade-out finish
    return () => clearTimeout(t);
  }, [visible]);

  if (!mounted) return null;

  const count = selectedIds.length;

  return (
    <div className={visible ? 'ema-scale-in' : 'ema-fade-out'}>
      <TooltipProvider>
        <Popover
          open={open}
          onOpenChange={setOpen}
          side="top"
          align="start"
          widthClass="w-72"
          trigger={
            <span className="relative inline-flex">
              <Tooltip content={count > 0 ? `知识库 · 已选 ${count} 个` : '选择知识库'}>
                <span className="inline-flex">
                  <IconButton
                    variant={count > 0 ? 'primary' : 'default'}
                    size="sm"
                    icon="i-solar:database-bold"
                    label="选择知识库"
                    toggled={count > 0}
                  />
                </span>
              </Tooltip>
              {count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none"
                      style={{ background: 'var(--ema-primary)', color: 'var(--ema-text-primary)' }}>
                  {count}
                </span>
              )}
            </span>
          }
        >
          <KbSelectorBody selectedIds={selectedIds} onChange={onChange} />
        </Popover>
      </TooltipProvider>
    </div>
  );
}

// ── KbSelectorBody ────────────────────────────────────────────────────────────
// Cursor-paginated document list (the backend listAssetsPaged returns nextCursor).

const KB_PAGE_SIZE = 20;

function KbSelectorBody({
  selectedIds, onChange,
}: {
  selectedIds: string[]; onChange(ids: string[]): void;
}): JSX.Element {
  const [items, setItems]           = useState<DocumentAssetWire[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);

  const loadPage = useCallback(async (cursor?: number): Promise<void> => {
    setLoading(true);
    try {
      const page = await kbApi.listDocuments({ cursor, limit: KB_PAGE_SIZE });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void loadPage(undefined); }, [loadPage]);

  function toggle(id: string): void {
    onChange(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium" style={{ color: 'var(--ema-text-secondary)' }}>选择知识库文档</p>
        {selectedIds.length > 0 && (
          <button
            className="text-xs transition-colors hover:text-[var(--ema-primary)]"
            style={{ color: 'var(--ema-text-tertiary)' }}
            onClick={() => onChange([])}
          >清空</button>
        )}
      </div>

      <ScrollArea className="max-h-56">
        <div className="flex flex-col gap-1 pr-1">
          {!loaded && loading ? (
            <div className="flex justify-center py-4"><Spinner size="sm" /></div>
          ) : items.length === 0 ? (
            <p className="text-xs py-3 text-center" style={{ color: 'var(--ema-text-tertiary)' }}>暂无文档，去设置 → 知识库上传</p>
          ) : (
            items.map((doc) => {
              const checked = selectedIds.includes(doc.id);
              return (
                <div
                  key={doc.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-ema"
                  style={{ background: checked ? 'var(--ema-primary-muted)' : 'transparent' }}
                  onClick={() => toggle(doc.id)}
                >
                  <Checkbox checked={checked} className="pointer-events-none" label={doc.fileName} />
                  <span className="text-xs truncate flex-1"
                        style={{ color: 'var(--ema-text-secondary)' }} title={doc.fileName}>
                    {doc.fileName}
                  </span>
                  {doc.status !== 'indexed' && (
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--ema-text-tertiary)' }}>
                      {doc.status === 'error' ? '错误' : '索引中'}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={loading}
          onClick={() => void loadPage(nextCursor)}
        >
          {loading ? <Spinner size="sm" /> : '加载更多'}
        </Button>
      )}
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
