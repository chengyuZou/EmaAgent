// 存储位置页(单库):库统计富卡 + Session 手风琴(单开) + 块扩散查看器。
// 六块(轮次/消息/Token/附件/音频/子代理):消息与 Token 进真查看器,其余"后续开放查看"。
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Badge, Button, EmptyState, Skeleton } from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage.js';
import { sessionsApi } from '../../api/sessions.js';
import { systemApi, type SessionSummary } from '../../api/system.js';
import { showToast } from '../../lib/toast.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { morphTransition, MORPH_NAME } from '../../lib/viewTransition.js';
import { MessageDetail } from './MessageDetail.js';
import { TokenDetail } from './TokenDetail.js';
import { fmtBytes, fmtDateFull, fmtDateShort, fmtDuration, fmtTokens } from './storageFormat.js';

/** 消息查看器每页条数:前端与后端 pageSize 的约定值,随每个分页请求传给端点;
    调整只改这里,分页条与请求参数同步生效。 */
const RAW_MESSAGES_PAGE_SIZE = 50;

type ViewerState =
  | { kind: 'messages'; sessionId: string; sessionTitle: string }
  | { kind: 'token'; sessionId: string; sessionTitle: string }
  | { kind: 'placeholder'; label: string };

export function StorageTab(): JSX.Element {
  const store = useStorageStore();
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const morphSourceRef = useRef<HTMLElement | null>(null);

  // 旧帧只给源块挂名，新帧只给查看器挂名；同一快照出现两个同名元素会让浏览器拒绝过渡。
  function openViewerMorph(next: ViewerState, sourceEl: HTMLElement | null): void {
    morphSourceRef.current = sourceEl;
    if (sourceEl) sourceEl.style.viewTransitionName = MORPH_NAME;
    void morphTransition(() => {
      if (sourceEl) sourceEl.style.viewTransitionName = '';
      setViewer(next);
    })?.catch(error => console.warn('[storage] 打开查看器过渡失败:', error));
  }

  function closeViewerMorph(): void {
    const sourceEl = morphSourceRef.current;
    const finished = morphTransition(() => {
      setViewer(null);
      if (sourceEl) sourceEl.style.viewTransitionName = MORPH_NAME;
    });
    const cleanup = (): void => {
      if (sourceEl) sourceEl.style.viewTransitionName = '';
      morphSourceRef.current = null;
    };
    if (!finished) {
      cleanup();
      return;
    }
    void finished
      .catch(error => console.warn('[storage] 关闭查看器过渡失败:', error))
      .finally(cleanup);
  }

  useEffect(() => {
    void store.refresh();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (
        event.type !== 'session_list_changed'
        && event.type !== 'turn_completed'
        && event.type !== 'turn_failed'
        && event.type !== 'turn_aborted'
      ) return;
      void useStorageStore.getState().refresh();
    });
    return unsubscribe;
  }, []);

  async function handleImport(file: File): Promise<void> {
    setImporting(true);
    try {
      const result = await sessionsApi.importSession(file);
      await store.refresh();
      showToast(
        result.warnings.length > 0
          ? `会话已导入,但有 ${result.warnings.length} 项内容缺失`
          : '会话导入成功',
        { variant: result.warnings.length > 0 ? 'warning' : 'success' },
      );
    } catch (err) {
      showToast(err instanceof Error ? `导入失败:${err.message}` : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(false);
    }
  }

  async function handleExport(session: SessionSummary): Promise<void> {
    setExporting(session.id);
    try {
      const response = await sessionsApi.exportSession(session.id);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${session.title || 'session'}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? `导出失败:${err.message}` : '导出失败', { variant: 'danger' });
    } finally {
      setExporting(null);
    }
  }

  const stats = store.stats;
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--ema-border)] px-6 py-4">
        <span className="text-base font-semibold text-[var(--ema-text-primary)]">存储位置</span>
        <span className="truncate font-mono text-xs text-[var(--ema-text-tertiary)]">
          ~/.ema-agent/data
        </span>
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          loading={importing}
          onClick={() => importRef.current?.click()}
        >
          <span className="i-solar:upload-minimalistic-bold-duotone" aria-hidden />导入会话
        </Button>
        <input
          ref={importRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="ema-fade-in flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6">
          {stats && <OverviewBand stats={stats} />}

          <div className="flex flex-col gap-2">
            {store.loading && store.sessions.length === 0 &&
              [0, 1, 2].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}
            {store.error && (
              <p className="py-10 text-center text-xs text-[var(--ema-danger)]">{store.error}</p>
            )}
            {!store.loading && !store.error && store.sessions.length === 0 && (
              <EmptyState
                icon="i-solar:inbox-archive-bold-duotone"
                title="还没有会话"
                hint="开始一段对话,或点右上角「导入会话」迁入备份"
                className="py-14"
              />
            )}
            {store.sessions.map((session, i) => (
              <SessionAccordion
                key={session.id}
                session={session}
                index={i}
                open={openSessionId === session.id}
                exporting={exporting === session.id}
                onToggle={() =>
                  setOpenSessionId(current => (current === session.id ? null : session.id))}
                onExport={() => void handleExport(session)}
                onOpenViewer={(next, sourceEl) => openViewerMorph(next, sourceEl)}
              />
            ))}
          </div>
        </div>
      </div>

      {viewer && (
        <ViewerOverlay
          viewer={viewer}
          onClose={closeViewerMorph}
        />
      )}
    </div>
  );
}

// ── Session 手风琴:折叠态行(标题+最后活跃+消息数+Token)+ 展开六块 ─────────────

function SessionAccordion({
  session, index, open, exporting, onToggle, onExport, onOpenViewer,
}: {
  session: SessionSummary;
  index: number;
  open: boolean;
  exporting: boolean;
  onToggle(): void;
  onExport(): void;
  onOpenViewer(viewer: ViewerState, sourceEl: HTMLElement | null): void;
}): JSX.Element {
  const title = session.title || '未命名会话';
  const tokenTotal = fmtTokens(session.totalInputTokens + session.totalOutputTokens);
  /* 展开过的内容常驻 DOM:收起时 0fr 网格负责裁剪,动画才能双向跑;
     若收起即卸载,内容在动画起跑前消失,折叠就成了瞬切。 */
  const [hasOpened, setHasOpened] = useState(open);
  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  return (
    <div
      className="ema-stagger-in overflow-hidden rounded-xl border border-[var(--ema-border)]
        bg-[var(--ema-surface-2)] transition-colors"
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <div className="ema-card-decorate ema-card-decorate--lines flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
          onClick={onToggle}
          aria-expanded={open}
        >
          <span className="i-solar:chat-round-bold-duotone text-[var(--ema-primary)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">{title}</p>
            <p className="text-xs text-[var(--ema-text-tertiary)]">
              {fmtDateShort(session.lastActivityAt)}
              {` · ${session.messageCount} 消息 · ${tokenTotal} Token`}
            </p>
          </div>
          <span
            className="i-lucide:chevron-down text-xs text-[var(--ema-text-tertiary)]
              transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            aria-hidden
          />
        </button>
        <div className="shrink-0 pr-2" onClick={e => e.stopPropagation()}>
          <Button variant="ghost" size="sm" loading={exporting} onClick={onExport}>
            <span className="i-solar:download-minimalistic-bold-duotone" aria-hidden />导出
          </Button>
        </div>
      </div>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {hasOpened && (
            <SessionBlocks
              sessionId={session.id}
              sessionTitle={title}
              onOpenViewer={onOpenViewer}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 展开态六块:统一规格,auto-fill 自适应,数字在块上 ──────────────────────────

function SessionBlocks({
  sessionId, sessionTitle, onOpenViewer,
}: {
  sessionId: string;
  sessionTitle: string;
  onOpenViewer(viewer: ViewerState, sourceEl: HTMLElement | null): void;
}): JSX.Element {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof systemApi.getSessionStats>> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const refresh = () => {
      const currentRequestId = ++requestId;
      systemApi.getSessionStats(sessionId)
        .then(result => {
          if (active && currentRequestId === requestId) {
            setStats(result);
            setFailed(false);
          }
        })
        .catch(() => { if (active && currentRequestId === requestId) setFailed(true); });
    };
    refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (
        event.type !== 'turn_completed'
        && event.type !== 'turn_failed'
        && event.type !== 'turn_aborted'
      ) return;
      if (event.sessionId !== sessionId) return;
      refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [sessionId]);

  if (failed) {
    return <p className="px-4 py-3 text-xs text-[var(--ema-danger)]">统计读取失败</p>;
  }
  if (!stats) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 px-4 pb-4">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
    );
  }

  const blocks: Array<{
    label: string;
    value: string | number;
    sub?: string;
    viewer?: ViewerState;
  }> = [
    { label: '轮次', value: stats.turnCount, viewer: { kind: 'placeholder', label: '轮次明细' } },
    {
      label: '消息', value: stats.messageCount,
      viewer: { kind: 'messages', sessionId, sessionTitle },
    },
    {
      label: 'Token',
      value: fmtTokens(stats.totalInputTokens + stats.totalOutputTokens),
      sub: `↑ ${fmtTokens(stats.totalInputTokens)} · ↓ ${fmtTokens(stats.totalOutputTokens)}`,
      viewer: { kind: 'token', sessionId, sessionTitle },
    },
    {
      label: '附件', value: stats.attachmentCount, sub: fmtBytes(stats.attachmentTotalBytes),
      viewer: { kind: 'placeholder', label: '附件查看(chat 会话内已有展示)' },
    },
    {
      label: '音频', value: stats.audioTurnCount, sub: fmtDuration(stats.audioTotalDurationMs),
      viewer: { kind: 'placeholder', label: '音频查看' },
    },
    { label: '子代理', value: stats.subagentCount, viewer: { kind: 'placeholder', label: '子代理视图' } },
  ];

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 border-t
        border-[var(--ema-border)] px-4 py-3"
    >
      {blocks.map((block, i) => (
        <button
          key={block.label}
          type="button"
          onClick={(event) => block.viewer && onOpenViewer(block.viewer, event.currentTarget)}
          className="ema-stagger-in ema-card-decorate ema-card-decorate--lines flex cursor-pointer flex-col gap-0.5 rounded-xl border
            border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2.5 text-left
            transition-all duration-[var(--ema-duration-fast)]
            hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-3)]"
          style={{ '--stagger-i': i } as CSSProperties}
        >
          <span className="text-[11px] text-[var(--ema-text-tertiary)]">{block.label}</span>
          <span className="truncate text-sm font-semibold text-[var(--ema-text-primary)]">
            {block.value}
          </span>
          {block.sub && (
            <span className="truncate text-[10px] text-[var(--ema-text-tertiary)]">{block.sub}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── 全幅查看器:扩散进入,关闭逆扩散 ─────────────────────────────────────────

function ViewerOverlay({
  viewer, onClose,
}: {
  viewer: ViewerState;
  onClose(): void;
}): JSX.Element {
  let title: string;
  let content: JSX.Element;
  if (viewer.kind === 'messages') {
    title = `原始消息 · ${viewer.sessionTitle}`;
    content = <RawMessageList sessionId={viewer.sessionId} />;
  } else if (viewer.kind === 'token') {
    title = `Token 明细 · ${viewer.sessionTitle}`;
    content = <TokenDetail sessionId={viewer.sessionId} />;
  } else {
    title = viewer.label;
    content = (
      <p className="py-16 text-center text-sm text-[var(--ema-text-tertiary)]">后续开放查看</p>
    );
  }
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-[var(--ema-bg)]"
      style={{ viewTransitionName: MORPH_NAME } as CSSProperties}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--ema-border)] px-6 py-4">
        <button
          className="flex items-center gap-1 text-sm text-[var(--ema-text-secondary)]
            hover:text-[var(--ema-text-primary)] transition-colors"
          onClick={onClose}
        >
          <span className="i-mdi:arrow-left" aria-hidden />返回
        </button>
        <span className="truncate text-base font-semibold text-[var(--ema-text-primary)]">{title}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {content}
      </div>
    </div>
  );
}

// ── 原始消息目录:分页只取行头，用户展开单条后才读取并高亮 blocks_json ──────────

type RawMessageHeader = Awaited<ReturnType<typeof systemApi.getRawMessages>>['messages'][number];

function RawMessageList({ sessionId }: { sessionId: string }): JSX.Element {
  const [messages, setMessages] = useState<RawMessageHeader[]>([]);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  // before 缺省=从头取(order 方向的第一页);切序时整体重取,不拼接两个方向的链。
  const load = useCallback((before?: { createdAt: number; id: string }) => {
    const currentRequestId = ++requestId.current;
    if (before) setLoadingMore(true);
    else setLoading(true);
    systemApi.getRawMessages(sessionId, {
      ...(before ? { before } : {}),
      order,
      limit: RAW_MESSAGES_PAGE_SIZE,
    }).then(result => {
      if (currentRequestId !== requestId.current) return;
      setMessages(current => before ? [...current, ...result.messages] : [...result.messages]);
      setCursor(result.nextCursor ?? null);
      setFailed(false);
    }).catch(() => { if (currentRequestId === requestId.current) setFailed(true); })
      .finally(() => {
        if (currentRequestId === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      });
  }, [sessionId, order]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (
        event.type !== 'turn_completed'
        && event.type !== 'turn_failed'
        && event.type !== 'turn_aborted'
      ) return;
      if (event.sessionId !== sessionId) return;
      load();
    });
    return unsubscribe;
  }, [sessionId, load]);

  if (failed) return <p className="py-10 text-center text-xs text-[var(--ema-danger)]">消息读取失败</p>;
  if (loading) {
    return <div className="flex flex-col gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>;
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end px-2 pb-1">
          <Button
            variant="ghost"
            size="sm"
            icon={order === 'asc' ? 'i-lucide:arrow-up-wide-narrow' : 'i-lucide:arrow-down-wide-narrow'}
            onClick={() => setOrder(current => (current === 'asc' ? 'desc' : 'asc'))}
          >
            {order === 'asc' ? '正序' : '倒序'}
          </Button>
      </div>
      {messages.length === 0 ? (
        <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">这个会话还没有消息</p>
      ) : (
        <div>
          {messages.map((message, index) => (
            <div
              key={message.id}
              className="ema-stagger-in-swift"
              style={{ '--stagger-i': index } as CSSProperties}
            >
              <RawMessageRow sessionId={sessionId} message={message} />
            </div>
          ))}
        </div>
      )}
      {cursor && (
        <div className="flex justify-center py-3">
          <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => load(cursor)}>
            {order === 'asc' ? '加载更晚的消息' : '加载更早的消息'}
          </Button>
        </div>
      )}
    </div>
  );
}

const RawMessageRow = memo(function RawMessageRow({
  sessionId,
  message,
}: {
  sessionId: string;
  message: RawMessageHeader;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  function toggle(): void {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen) setHasOpened(true);
  }

  return (
    <div className="border-b border-[var(--ema-border)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors
          hover:bg-[var(--ema-surface-2)]"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className={`text-xs font-medium ${message.role === 'user'
          ? 'text-[var(--ema-primary-text)]'
          : 'text-[var(--ema-text-secondary)]'}`}
        >
          {message.role}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ema-text-tertiary)]">
          {message.id}
        </span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">{fmtDateFull(message.createdAt)}</span>
        <span
          className="i-lucide:chevron-down text-xs text-[var(--ema-text-tertiary)]
            transition-transform duration-[var(--ema-duration-fast)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {hasOpened && <MessageDetail sessionId={sessionId} messageId={message.id} />}
        </div>
      </div>
    </div>
  );
});

// ── 总览仪表带:静态一行概览,不可展开;图标统一主色,是全页唯一的常驻装饰位。 ──

function OverviewBand({ stats }: { stats: NonNullable<ReturnType<typeof useStorageStore.getState>['stats']> }): JSX.Element {
  const items: Array<{ icon: string; label: string; value: string | number }> = [
    { icon: 'i-solar:chat-round-bold-duotone',      label: '会话',   value: stats.sessionCount },
    { icon: 'i-solar:refresh-circle-bold-duotone',  label: '轮次',   value: stats.turnCount },
    { icon: 'i-solar:letter-bold-duotone',          label: '消息',   value: stats.messageCount },
    { icon: 'i-solar:bolt-bold-duotone',            label: 'Token',  value: fmtTokens(stats.totalInputTokens + stats.totalOutputTokens) },
    { icon: 'i-solar:paperclip-bold-duotone',       label: '附件',   value: stats.attachmentCount },
    { icon: 'i-solar:soundwave-bold-duotone',       label: '音频',   value: stats.audioCount },
    { icon: 'i-solar:magic-stick-3-bold-duotone',   label: '子代理', value: stats.subagentCount },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
        <span className="text-xs font-semibold text-[var(--ema-text-primary)]">总览</span>
        {items.map(item => (
          <span key={item.label} className="flex items-center gap-1 text-xs text-[var(--ema-text-tertiary)]">
            <span className={`${item.icon} text-[var(--ema-primary)]`} aria-hidden />
            <span className="font-medium text-[var(--ema-text-primary)]">{item.value}</span>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
