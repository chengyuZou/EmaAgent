// 存储位置页(单库):库统计富卡 + Session 手风琴(单开) + 块扩散查看器。
// 六块(轮次/消息/Token/附件/音频/子代理):消息与 Token 进真查看器,其余"后续开放查看"。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Badge, Button, EmptyState, Skeleton, StatCard } from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage.js';
import { sessionsApi } from '../../api/sessions.js';
import { systemApi, type SessionSummary } from '../../api/system.js';
import { showToast } from '../../lib/toast.js';
import { morphTransition, MORPH_NAME } from '../../lib/viewTransition.js';
import { Markdown } from '../../markdown/renderer.js';
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

  useEffect(() => {
    void store.loadAll();
  }, []);

  async function handleImport(file: File): Promise<void> {
    setImporting(true);
    try {
      const result = await sessionsApi.importSession(file);
      await store.loadAll(true);
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

      <div className="flex-1 overflow-y-auto p-6">
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
                onOpenViewer={next => morphTransition(() => setViewer(next))}
              />
            ))}
          </div>
        </div>
      </div>

      {viewer && (
        <ViewerOverlay
          viewer={viewer}
          onClose={() => morphTransition(() => setViewer(null))}
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
  onOpenViewer(viewer: ViewerState): void;
}): JSX.Element {
  const title = session.title || '未命名会话';
  const tokenTotal = fmtTokens(session.totalInputTokens + session.totalOutputTokens);

  return (
    <div
      className="ema-stagger-in overflow-hidden rounded-xl border border-[var(--ema-border)]
        bg-[var(--ema-surface-2)] transition-colors"
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors
            hover:bg-[var(--ema-surface-3)]"
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
          {open && (
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
  onOpenViewer(viewer: ViewerState): void;
}): JSX.Element {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof systemApi.getSessionStats>> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    systemApi.getSessionStats(sessionId)
      .then(result => { if (active) setStats(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
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
    { label: '子代理', value: stats.agentRunCount, viewer: { kind: 'placeholder', label: '子代理视图' } },
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
          onClick={() => block.viewer && onOpenViewer(block.viewer)}
          className="ema-stagger-in flex cursor-pointer flex-col gap-0.5 rounded-xl border
            border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2.5 text-left
            transition-all duration-[var(--ema-duration-fast)]
            hover:border-[var(--ema-primary)]/40 hover:bg-[var(--ema-surface-3)] hover:-translate-y-0.5"
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
  const title = viewer.kind === 'messages'
    ? `原始消息 · ${viewer.sessionTitle}`
    : viewer.kind === 'token'
      ? `Token 明细 · ${viewer.sessionTitle}`
      : viewer.label;
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
        {viewer.kind === 'messages' ? (
          <RawMessageList sessionId={viewer.sessionId} />
        ) : viewer.kind === 'token' ? (
          <TokenDetail sessionId={viewer.sessionId} />
        ) : (
          <p className="py-16 text-center text-sm text-[var(--ema-text-tertiary)]">后续开放查看</p>
        )}
      </div>
    </div>
  );
}

// ── 原始消息列表:role • msg_id + 时间行,行内手风琴展开 blocks_json(Markdown JSON 高亮) ──

type RawMessage = Awaited<ReturnType<typeof systemApi.getRawMessages>>['messages'][number];

function RawMessageList({ sessionId }: { sessionId: string }): JSX.Element {
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<{ createdAt: number; id: string } | null>(null);
  const [failed, setFailed] = useState(false);

  // before 缺省=从头取(order 方向的第一页);切序时整体重取,不拼接两个方向的链。
  const load = useCallback((before?: { createdAt: number; id: string }) => {
    if (before) setLoadingMore(true);
    else setLoading(true);
    systemApi.getRawMessages(sessionId, {
      ...(before ? { before } : {}),
      order,
      limit: RAW_MESSAGES_PAGE_SIZE,
    }).then(result => {
      setMessages(current => before ? [...current, ...result.messages] : [...result.messages]);
      setCursor(result.nextCursor ?? null);
    }).catch(() => setFailed(true))
      .finally(() => { setLoading(false); setLoadingMore(false); });
  }, [sessionId, order]);

  useEffect(() => { load(); }, [load]);

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
        messages.map(message => (
          <RawMessageRow key={message.id} message={message} />
        ))
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

function RawMessageRow({ message }: { message: RawMessage }): JSX.Element {
  const [open, setOpen] = useState(false);
  const pretty = useMemo(() => {
    // blocks_json 原生是 JSON 文本;格式化失败就原样展示,绝不因脏数据挂掉整行。
    try {
      return JSON.stringify(JSON.parse(message.blocks_json), null, 2);
    } catch {
      return message.blocks_json;
    }
  }, [message.blocks_json]);

  return (
    <div className="border-b border-[var(--ema-border)]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors
          hover:bg-[var(--ema-surface-2)]"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className={`text-xs font-medium ${message.role === 'user'
          ? 'text-[var(--ema-primary)]'
          : 'text-[var(--ema-text-secondary)]'}`}
        >
          {message.role}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ema-text-tertiary)]">
          {message.id}
        </span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">{fmtDateFull(message.created_at)}</span>
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
          <div className="ema-raw-json mx-2 mb-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-0)]">
            <Markdown source={`\`\`\`json\n${pretty}\n\`\`\``} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 总览细条:默认收起成一条仪表带(项不可点,整条是开关),展开为富卡墙。
// ema-collapsible 双向(展开/收起都平滑) + chevron 旋转 + 内容随带淡入淡出。 ──

function OverviewBand({ stats }: { stats: NonNullable<ReturnType<typeof useStorageStore.getState>['stats']> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const items: Array<{ icon: string; label: string; value: string | number }> = [
    { icon: 'i-solar:chat-round-bold-duotone',      label: '会话',   value: stats.sessionCount },
    { icon: 'i-solar:refresh-circle-bold-duotone',  label: '轮次',   value: stats.turnCount },
    { icon: 'i-solar:letter-bold-duotone',          label: '消息',   value: stats.messageCount },
    { icon: 'i-solar:bolt-bold-duotone',            label: 'Token',  value: fmtTokens(stats.totalInputTokens + stats.totalOutputTokens) },
    { icon: 'i-solar:paperclip-bold-duotone',       label: '附件',   value: stats.attachmentCount },
    { icon: 'i-solar:soundwave-bold-duotone',       label: '音频',   value: stats.audioCount },
    { icon: 'i-solar:magic-stick-3-bold-duotone',   label: '子代理', value: stats.agentRunCount },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left
          transition-colors hover:bg-[var(--ema-surface-2)]"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ema-text-primary)]">
          <span
            className="i-lucide:chevron-down text-xs text-[var(--ema-text-tertiary)]
              transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            aria-hidden
          />
          总览
        </span>
        {items.map(item => (
          <span key={item.label} className="flex items-center gap-1 text-xs text-[var(--ema-text-tertiary)]">
            <span className={`${item.icon} text-[var(--ema-primary)]/80`} aria-hidden />
            <span className="font-medium text-[var(--ema-text-primary)]">{item.value}</span>
            {item.label}
          </span>
        ))}
      </button>
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          <div className="grid grid-cols-2 gap-3 border-t border-[var(--ema-border)] p-4 xl:grid-cols-4">
            <StatCard index={0} decorate="ema-card-decorate--storage" icon="i-solar:chat-round-bold-duotone"
              label="会话" value={stats.sessionCount} />
            <StatCard index={1} decorate="ema-card-decorate--storage" icon="i-solar:refresh-circle-bold-duotone"
              label="轮次" value={stats.turnCount} />
            <StatCard index={2} decorate="ema-card-decorate--storage" icon="i-solar:letter-bold-duotone"
              label="消息" value={stats.messageCount} />
            <StatCard index={3} decorate="ema-card-decorate--storage" icon="i-solar:bolt-bold-duotone"
              label="Token" value={fmtTokens(stats.totalInputTokens + stats.totalOutputTokens)}
              sub={`↑ ${fmtTokens(stats.totalInputTokens)} · ↓ ${fmtTokens(stats.totalOutputTokens)}`} />
            <StatCard index={4} decorate="ema-card-decorate--storage" icon="i-solar:magic-stick-3-bold-duotone"
              label="子智能体执行" value={stats.agentRunCount} />
            <StatCard index={5} decorate="ema-card-decorate--storage" icon="i-solar:paperclip-bold-duotone"
              label="附件" value={stats.attachmentCount} sub={fmtBytes(stats.attachmentTotalBytes)} />
            <StatCard index={6} decorate="ema-card-decorate--storage" icon="i-solar:soundwave-bold-duotone"
              label="音频轮次" value={stats.audioCount} sub={fmtDuration(stats.audioDurationMs)} />
          </div>
        </div>
      </div>
    </div>
  );
}
