import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type JSX, type ChangeEvent } from 'react';
import { IconButton, Input, Button, Popover, Tooltip, TooltipProvider, Checkbox, ScrollArea, Spinner, Switch } from '@ema-agent/ui';
import { kbApi, type DocumentAssetWire, type KbLibraryWire } from '../api/knowledge-base.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { ModeSelector } from './ModeSelector.js';
import { ModelPicker, type ModelSelection } from './ModelPicker.js';
import { AttachmentChip } from './AttachmentChip.js';
import { showToast } from '../lib/toast.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { AttachmentInputWire } from '../api/turns.js';
import type { TurnMode } from '@ema-agent/contracts';
import { WorkspacePicker } from './WorkspacePicker.js';

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

// 用 Tauri 拿真实 size/mtime，避免硬编码 0 绕过 5MB 图片内联限制（大图静默 turn_failed）。
// browser/Ladle 模式 fileMetadata 返回 null，回退 0 保持兼容。目录不作为附件。
async function pathToAttachmentAsync(localPath: string): Promise<AttachmentInputWire | null> {
  const name = localPath.replace(/\\/g, '/').split('/').pop() ?? localPath;
  const meta = await tauriBridge.fileMetadata(localPath);
  if (meta?.isDir) return null;
  return {
    id:        crypto.randomUUID(),
    name,
    mimeType:  mimeFromName(name),
    size:      meta?.size ?? 0,
    mtime:     meta?.mtime ?? 0,
    localPath,
  };
}

export function ChatInput(): JSX.Element {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const ttsEnabled = useUiStore((s) => s.ttsEnabled);

  const initialDraft = useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '';
  const [text, setText] = useState(initialDraft);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentInputWire[]>([]);
  // Map<kbId, assetId[]> — per-KB doc selection; persists when switching library tabs.
  const [selectedScopes,   setSelectedScopes]   = useState<Map<string, string[]>>(new Map());
  const [selectedModel,    setSelectedModel]    = useState<ModelSelection | null>(null);
  const [thinkingEnabled,  setThinkingEnabled]  = useState(false);
  // 拖动上传：文件拖入对话框区域时高亮
  const [isDragOver,       setIsDragOver]       = useState(false);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);
  const inputBoxRef     = useRef<HTMLDivElement>(null); // 拖放命中检测基准
  const prevViewedIdRef = useRef(viewedId);
  const TEXTAREA_MAX_H  = 200; // px — beyond this the textarea scrolls

  useEffect(() => {
    if (prevViewedIdRef.current === viewedId) return;
    prevViewedIdRef.current = viewedId;
    setText(useConversationStore.getState().draftMap.get(viewedId as string ?? '') ?? '');
    setSelectedScopes(new Map()); // KB selection is per-session; reset when switching sessions
  }, [viewedId]);

  // Auto-resize textarea height based on content, capped at TEXTAREA_MAX_H.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`;
  }, [text]);

  const sessionMode = useSessionStore((s) =>
    viewedId ? s.sessionModes.get(viewedId as string) : undefined,
  );
  const mode = sessionMode?.mode ?? 'chat';

  const hasAnyStreaming  = useConversationStore((s) => s.streamingMap.size > 0);
  const isStreamingHere = useConversationStore((s) =>
    viewedId ? s.streamingMap.has(viewedId as string) : false,
  );
  // 附件-only 也可发送（后端 turns.ts refine 同步放行）
  const canSend = (text.trim().length > 0 || pendingAttachments.length > 0) && !isStreamingHere;

  function handleChange(value: string): void {
    setText(value);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, value);
  }

  // 多选文件 + 批量拿真实元数据。目录/不可访问文件过滤掉。
  async function pickAttachment(): Promise<void> {
    const paths = await tauriBridge.openFileDialogMultiple();
    if (paths.length === 0) return;
    const atts = (await Promise.all(paths.map(pathToAttachmentAsync)))
      .filter((a): a is AttachmentInputWire => a !== null);
    if (atts.length === 0) {
      showToast('所选文件不可用', { variant: 'warning' });
      return;
    }
    setPendingAttachments((prev) => [...prev, ...atts]);
  }

  function removeAttachment(id: string): void {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  // 拖动上传：Tauri 原生 onDragDropEvent（webview 级，物理像素）。位置命中对话框区域才收。
  // 物理像素 → CSS 像素需除以 devicePixelRatio，才能与 getBoundingClientRect 比较。
  useEffect(() => {
    let unlisten = () => {};
    void tauriBridge.onDragDrop((ev) => {
      const rect = inputBoxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const inside = ev.position
        ? (ev.position.x / window.devicePixelRatio >= rect.left &&
           ev.position.x / window.devicePixelRatio <= rect.right &&
           ev.position.y / window.devicePixelRatio >= rect.top &&
           ev.position.y / window.devicePixelRatio <= rect.bottom)
        : false;
      if (ev.type === 'enter' || ev.type === 'over') {
        setIsDragOver(inside);
      } else if (ev.type === 'drop') {
        setIsDragOver(false);
        const paths = ev.paths ?? [];
        if (!inside || paths.length === 0) return;
        void (async () => {
          const atts = (await Promise.all(paths.map(pathToAttachmentAsync)))
            .filter((a): a is AttachmentInputWire => a !== null);
          if (atts.length > 0) setPendingAttachments((prev) => [...prev, ...atts]);
        })();
      } else if (ev.type === 'leave') {
        setIsDragOver(false);
      }
    }).then((u) => { unlisten = u; });
    return () => unlisten();
  }, []);

  const send = useCallback(() => {
    if (!canSend) return;
    void useConversationStore.getState().sendMessage(viewedId, {
      mode,
      text: text.trim(),
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      providerId:      selectedModel?.providerId,
      model:           selectedModel?.model,
      ttsEnabled,
      thinkingEnabled: thinkingEnabled || undefined,
      // KB scope applies to agent mode only. Selection persists across sends.
      ...(() => {
        if (mode !== 'agent' || selectedScopes.size === 0) return {};
        const scopes = [...selectedScopes.entries()]
          .filter(([, ids]) => ids.length > 0)
          .map(([kbId, assetIds]) => ({ kbId, assetIds }));
        if (scopes.length === 0) return {};
        return {
          kbIds:         scopes.map((s) => s.kbId),
          kbAssetScopes: scopes,
        };
      })(),
    });
    setText('');
    setPendingAttachments([]);
    if (viewedId) useConversationStore.getState().setDraft(viewedId, '');
  }, [canSend, mode, text, pendingAttachments, ttsEnabled, thinkingEnabled, viewedId, selectedScopes]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
        <div
          ref={inputBoxRef}
          className="relative rounded-2xl transition-shadow bg-[var(--ema-surface-2)]"
          style={{
            boxShadow: isDragOver
              ? '0 0 0 2px var(--ema-primary), 0 0 24px var(--ema-glow)'
              : undefined,
          }}
        >
          {/* 拖放遮罩 — 拖入对话框区域时显示 */}
          {isDragOver && (
            <div className="absolute inset-0 z-10 rounded-2xl flex items-center justify-center pointer-events-none ema-fade-in"
                 style={{ background: 'color-mix(in srgb, var(--ema-primary) 14%, transparent)' }}>
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--ema-text-primary)]">
                <span className="i-mdi:tray-arrow-down text-xl" aria-hidden />
                放下以上传文件
              </div>
            </div>
          )}

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
              className="relative w-full bg-transparent rounded-2xl px-4 py-3 pr-12 text-sm resize-none focus:outline-none overflow-y-auto text-[var(--ema-text-secondary)]"
              style={{ minHeight: 60, maxHeight: TEXTAREA_MAX_H }}
              rows={1}
              placeholder="输入消息…"
              value={text}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
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
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                  {pendingAttachments.length}
                </span>
              )}
            </div>

            <KbButton
              visible={mode === 'agent'}
              selectedScopes={selectedScopes}
              onScopesChange={setSelectedScopes}
            />

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
              onSelect={(sel) => {
                setSelectedModel(sel);
                if (!sel.reasoning) setThinkingEnabled(false);
              }}
              onClear={() => { setSelectedModel(null); setThinkingEnabled(false); }}
            />

            {/* 启用思考 — 仅当所选模型支持思考时显示 */}
            {selectedModel?.reasoning && (
              <div className="flex items-center gap-1 px-1 ema-fade-in">
                <Switch
                  checked={thinkingEnabled}
                  onCheckedChange={setThinkingEnabled}
                  label="启用思考"
                />
                <span className="text-[11px] select-none text-[var(--ema-text-tertiary)]">
                  思考
                </span>
              </div>
            )}

            <ModeSelector
              mode={mode}
              onModeChange={(m) => {
                if (viewedId) void useSessionStore.getState().setSessionMode(viewedId, m as TurnMode);
              }}
            />
          </div>

          {hasAnyStreaming && (
            <div className="text-xs flex items-center gap-1.5 text-[var(--ema-text-tertiary)]">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--ema-primary)]" aria-hidden />
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
  visible, selectedScopes, onScopesChange,
}: {
  visible: boolean;
  selectedScopes: Map<string, string[]>;
  onScopesChange(scopes: Map<string, string[]>): void;
}): JSX.Element | null {
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen]       = useState(false);

  useEffect(() => {
    if (visible) { setMounted(true); return; }
    setOpen(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [visible]);

  if (!mounted) return null;

  const count = [...selectedScopes.values()].reduce((s, ids) => s + ids.length, 0);

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
              <Tooltip content={count > 0 ? `知识库 · 已选 ${count} 个文档` : '选择知识库'}>
                <span className="inline-flex">
                  <IconButton
                    variant={count > 0 ? 'primary' : 'default'}
                    size="sm"
                    icon="i-mdi:database"
                    label="选择知识库"
                    toggled={count > 0}
                  />
                </span>
              </Tooltip>
              {count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                  {count}
                </span>
              )}
            </span>
          }
        >
          <KbSelectorBody selectedScopes={selectedScopes} onScopesChange={onScopesChange} />
        </Popover>
      </TooltipProvider>
    </div>
  );
}

// ── KbSelectorBody ────────────────────────────────────────────────────────────
// Two-level picker: pick a KB library tab, then select documents within it.
// Switching tabs preserves selections from other KBs (selectedScopes is per-KB).

const KB_PAGE_SIZE = 20;

function KbDocList({
  kbId, selectedIds, onScopeChange,
}: {
  kbId: string;
  selectedIds: string[];
  onScopeChange(ids: string[]): void;
}): JSX.Element {
  const [items, setItems]           = useState<DocumentAssetWire[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);

  const loadPage = useCallback(async (cursor?: number): Promise<void> => {
    setLoading(true);
    try {
      const page = await kbApi.listDocuments({ cursor, limit: KB_PAGE_SIZE, kbId });
      setItems((prev) => (cursor === undefined ? page.items : [...prev, ...page.items]));
      setNextCursor(page.nextCursor);
    } finally { setLoading(false); setLoaded(true); }
  }, [kbId]);

  useEffect(() => { void loadPage(undefined); }, [loadPage]);

  function toggle(id: string): void {
    onScopeChange(selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]);
  }

  return (
    <div className="flex flex-col gap-1 ema-slide-down">
      <ScrollArea viewportClassName="max-h-44">
        <div className="flex flex-col gap-0.5 pr-1">
          {!loaded && loading ? (
            <div className="flex justify-center py-4 ema-fade-in"><Spinner size="sm" /></div>
          ) : items.length === 0 ? (
            <p className="text-xs py-3 text-center ema-fade-in text-[var(--ema-text-tertiary)]">
              此知识库暂无文档，去设置 → 知识库上传
            </p>
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
                  <span className="text-xs truncate flex-1 text-[var(--ema-text-secondary)]" title={doc.fileName}>
                    {doc.fileName}
                  </span>
                  {doc.status !== 'indexed' && (
                    <span className="text-[10px] shrink-0 text-[var(--ema-text-tertiary)]">
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
        <Button variant="ghost" size="sm" className="w-full ema-fade-in" disabled={loading}
                onClick={() => void loadPage(nextCursor)}>
          {loading ? <Spinner size="sm" /> : '加载更多'}
        </Button>
      )}
    </div>
  );
}

function KbSelectorBody({
  selectedScopes, onScopesChange,
}: {
  selectedScopes:  Map<string, string[]>;
  onScopesChange(scopes: Map<string, string[]>): void;
}): JSX.Element {
  const [libs, setLibs]             = useState<KbLibraryWire[]>([]);
  const [libsLoaded, setLibsLoaded] = useState(false);
  const [shownLibId, setShownLibId] = useState<string | null>(null);

  useEffect(() => {
    void kbApi.listLibs().then((list) => {
      setLibs(list);
      setLibsLoaded(true);
      const active = list.find((l) => l.isActive);
      if (active) setShownLibId(active.id);
      else if (list[0]) setShownLibId(list[0].id);
    }).catch(() => { setLibsLoaded(true); });
  }, []);

  function handleScopeChange(kbId: string, ids: string[]): void {
    const next = new Map(selectedScopes);
    if (ids.length === 0) next.delete(kbId);
    else next.set(kbId, ids);
    onScopesChange(next);
  }

  function clearAll(): void {
    onScopesChange(new Map());
  }

  const totalCount = [...selectedScopes.values()].reduce((s, ids) => s + ids.length, 0);
  const shownLib   = libs.find((l) => l.id === shownLibId);

  return (
    <div className="flex flex-col gap-2">
      {/* ── Header row ── */}
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)]">知识库</p>
        {totalCount > 0 && (
          <button
            className="text-xs transition-colors hover:text-[var(--ema-primary)] text-[var(--ema-text-tertiary)]"
            onClick={clearAll}
          >清空全部</button>
        )}
      </div>

      {!libsLoaded ? (
        <div className="flex justify-center py-3 ema-fade-in"><Spinner size="sm" /></div>
      ) : libs.length === 0 ? (
        <p className="text-xs py-3 text-center ema-fade-in text-[var(--ema-text-tertiary)]">
          暂无知识库，去设置 → 知识库创建
        </p>
      ) : (
        <>
          {/* ── Library tabs — switching preserves other KBs' selections ── */}
          {libs.length > 1 && (
            <div className="flex flex-wrap gap-1 ema-slide-up">
              {libs.map((lib) => {
                const libCount = selectedScopes.get(lib.id)?.length ?? 0;
                return (
                  <button
                    key={lib.id}
                    className={`text-xs px-2 py-0.5 rounded-full transition-ema relative ${lib.id === shownLibId ? 'bg-[var(--ema-primary)] text-[var(--ema-text-on-primary)]' : 'bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)]'}`}
                    onClick={() => setShownLibId(lib.id)}
                  >
                    {lib.name}
                    {lib.isActive && <span className="ml-1 opacity-60 text-[9px]">●</span>}
                    {libCount > 0 && (
                      <span className="ml-1 text-[9px] font-mono opacity-80">{libCount}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {shownLib && (
            <KbDocList
              key={shownLib.id}
              kbId={shownLib.id}
              selectedIds={selectedScopes.get(shownLib.id) ?? []}
              onScopeChange={(ids) => handleScopeChange(shownLib.id, ids)}
            />
          )}
        </>
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
  const hasRoot = !!session?.workspaceRoot;

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
        variant={hasRoot ? 'primary' : 'default'}
        size="sm"
        icon="i-mdi:folder-outline"
        label={hasRoot ? '工作区目录' : '未设置工作区目录'}
        toggled={hasRoot}
        onClick={handleClick}
      />

      {open && session && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <WorkspacePicker
            session={session}
            positionClassName="bottom-full left-0 mb-2"
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}

// ── WorkspaceEditor ───────────────────────────────────────────────────────────
// (removed — replaced by the shared WorkspacePicker component)

