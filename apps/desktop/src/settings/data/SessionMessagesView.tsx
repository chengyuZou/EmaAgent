// L3:Session 原生消息流——raw 行展示(blocks_json 原文可展开),附件行按块渲染
// (图片给封面缩略图,其余 chip 纯展示不点开)。keyset 分页向回翻。
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Button, Skeleton } from '@ema-agent/ui';
import { dataDirsApi } from '../../api/workspaces.js';
import { useStorageStore } from '../../stores/storage.js';
import { fmtDateFull } from './storageFormat.js';

interface RawMessage {
  id: string;
  session_id: string;
  turn_id: string | null;
  role: 'system' | 'user' | 'assistant';
  kind: string;
  blocks_json: string;
  interrupted: number;
  created_at: number;
}

interface AttachmentBlockLite {
  type: 'image_reference' | 'pasted_text_reference' | 'file_reference';
  path: string;
  name?: string;
  preview?: string;
}

const PAGE_SIZE = 50;

export function SessionMessagesView({
  dirName, sessionId, sessionTitle, onBack,
}: {
  dirName: string;
  sessionId: string;
  sessionTitle: string;
  onBack(): void;
}): JSX.Element {
  const store = useStorageStore();
  const isActive = store.activeName === dirName;
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(async (before?: number) => {
    const result = await dataDirsApi.dirSessionMessages(dirName, sessionId, {
      ...(before !== undefined ? { before } : {}),
      limit: PAGE_SIZE,
    });
    return result.messages as unknown as RawMessage[];
  }, [dirName, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().then(rows => {
      if (cancelled) return;
      setMessages(rows);
      setExhausted(rows.length < PAGE_SIZE);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [load]);

  async function loadMore(): Promise<void> {
    const oldest = messages[messages.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const rows = await load(oldest.created_at);
      setMessages(prev => [...prev, ...rows]);
      setExhausted(rows.length < PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--ema-border)] shrink-0">
        <button
          className="flex items-center gap-1 text-sm text-[var(--ema-text-secondary)]
            hover:text-[var(--ema-text-primary)] transition-colors"
          onClick={onBack}
        >
          <span className="i-mdi:arrow-left" aria-hidden />{dirName}
        </button>
        <span className="text-base font-semibold text-[var(--ema-text-primary)] truncate">{sessionTitle}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 rounded-xl mb-2" />)}
        {!loading && messages.length === 0 && (
          <p className="text-xs text-[var(--ema-text-tertiary)] text-center py-10">这个会话还没有消息</p>
        )}
        <div className="flex flex-col gap-2">
          {messages.map(message => (
            <MessageRow key={message.id} message={message} sessionId={sessionId} isActive={isActive} />
          ))}
        </div>
        {!loading && !exhausted && (
          <div className="flex justify-center py-4">
            <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
              加载更早的消息
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 单条消息 ──────────────────────────────────────────────────────────────────

function MessageRow({
  message, sessionId, isActive,
}: {
  message: RawMessage;
  sessionId: string;
  isActive: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const attachments = extractAttachmentBlocks(message.blocks_json);

  return (
    <div
      className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-2.5
        cursor-pointer hover:bg-[var(--ema-surface-3)] transition-colors"
      onClick={() => setOpen(v => !v)}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
        <RoleBadge role={message.role} />
        <span className="font-mono">{message.id}</span>
        {message.kind !== 'normal' && <span className="rounded px-1 bg-[var(--ema-surface-4)]">{message.kind}</span>}
        {message.interrupted === 1 && <span className="text-[var(--ema-warning)]">已中断</span>}
        <span className="ml-auto">{fmtDateFull(message.created_at)}</span>
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-2">
          {attachments.map((block, i) => (
            <AttachmentLine key={`${block.path}:${i}`} block={block} sessionId={sessionId} isActive={isActive} />
          ))}
        </div>
      )}

      <pre className={`mt-2 text-[11px] font-mono text-[var(--ema-text-secondary)]
          bg-black/20 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all
          ${open ? 'max-h-96 overflow-y-auto' : 'max-h-10 overflow-hidden'}`}>
        {message.blocks_json}
      </pre>
    </div>
  );
}

function RoleBadge({ role }: { role: RawMessage['role'] }): JSX.Element {
  const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : '系统';
  const cls = role === 'user'
    ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
    : role === 'assistant'
      ? 'text-[var(--ema-info)] bg-[var(--ema-info-muted)]'
      : 'text-[var(--ema-text-tertiary)] bg-[var(--ema-surface-4)]';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

// ── 附件行:图片给封面(活动库经内容端点缩略图),其余 chip 纯展示 ────────────────

function AttachmentLine({
  block, sessionId, isActive,
}: {
  block: AttachmentBlockLite;
  sessionId: string;
  isActive: boolean;
}): JSX.Element {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (block.type !== 'image_reference' || !isActive || tried.current) return;
    tried.current = true;
    void (async () => {
      try {
        const { serverClient } = await import('../../api/client.js');
        const response = await serverClient.requestRaw(
          `/api/sessions/${encodeURIComponent(sessionId)}/attachments/content?path=${encodeURIComponent(block.path)}&thumb=1`,
        );
        if (!response.ok) return;
        setCoverUrl(URL.createObjectURL(await response.blob()));
      } catch { /* 封面拉不到就退回图标 chip */ }
    })();
  }, [block.path, block.type, isActive, sessionId]);

  if (block.type === 'image_reference') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)] px-2 py-1.5">
        {coverUrl
          ? <img src={coverUrl} alt={block.name ?? '图片'} className="h-10 w-10 rounded object-cover" />
          : <span className="i-lucide:image text-[var(--ema-file-image)]" aria-hidden />}
        <span className="text-xs text-[var(--ema-text-secondary)] truncate">
          {block.name ?? '剪贴板图片'}
        </span>
      </div>
    );
  }
  if (block.type === 'pasted_text_reference') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)] px-2 py-1.5">
        <span className="i-lucide:clipboard-paste text-[var(--ema-warning)]" aria-hidden />
        <span className="text-xs text-[var(--ema-text-secondary)] truncate">
          粘贴文本{block.preview ? `:${block.preview.slice(0, 40)}` : ''}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-3)] px-2 py-1.5">
      <span className="i-lucide:file text-[var(--ema-file-text)]" aria-hidden />
      <span className="text-xs text-[var(--ema-text-secondary)] truncate">
        {block.path.split(/[\\/]/).pop() ?? block.path}
      </span>
    </div>
  );
}

function extractAttachmentBlocks(blocksJson: string): AttachmentBlockLite[] {
  try {
    const value: unknown = JSON.parse(blocksJson);
    if (!Array.isArray(value)) return [];
    return value.filter((block): block is AttachmentBlockLite =>
      typeof block === 'object' && block !== null
      && 'type' in block
      && (block.type === 'image_reference'
        || block.type === 'pasted_text_reference'
        || block.type === 'file_reference')
      && 'path' in block && typeof block.path === 'string',
    );
  } catch {
    return [];
  }
}
