import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Skeleton, Tooltip } from '@ema-agent/ui';
import { turnsApi, type TurnDetailResult, type TurnSummary, type TurnSummaryPage } from '../../../api/turns.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { fmtDateFull, fmtTokens } from '../storageFormat.js';
import { MessageDetail } from './messageDetail.js';
import { ToolDetail } from './toolDetail.js';
import { useDetailPages } from '../useDetailPages.js';

const turnId = (turn: TurnSummary): string => turn.id;

export function TurnDetail({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const readPage = useCallback((before: TurnSummaryPage['nextCursor'] | undefined, signal: AbortSignal) => {
    return turnsApi.listSummaries(sessionId, before ?? undefined, signal);
  }, [sessionId]);
  const { items, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, turnId);
  useEffect(() => subscribeSystemEvent(event => {
    if (
      (event.type === 'turn_started' || event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
      && event.sessionId === sessionId
    ) {
      refresh();
    }
    if (event.type === 'session_list_changed' && event.sessionId === sessionId) {
      refresh();
    }
  }), [sessionId, refresh]);
  const toggle = useCallback((id: string) => setOpenId(current => current === id ? null : id), []);

  return (
    <section className="flex flex-col gap-2" aria-label="轮次记录">
      <p className="mb-1 text-xs text-[var(--ema-text-tertiary)]">最新在前 · 已加载 {items.length} 轮</p>
      {failed && (
        <div className="flex items-center gap-2 py-3">
          <p className="text-xs text-[var(--ema-danger)]">轮次目录读取失败</p>
          <Button variant="ghost" size="sm" onClick={refresh}>
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : (
        <>
          {!failed && items.length === 0 && (
            <p className="py-6 text-center text-xs text-[var(--ema-text-tertiary)]">没有轮次记录</p>
          )}
          {items.map(turn => (
            <TurnRow
              key={turn.id}
              turn={turn}
              open={openId === turn.id}
              onToggle={toggle}
            />
          ))}
          {cursor && (
            <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
              加载更早的轮次
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const TurnRow = memo(function TurnRow({ turn, open, onToggle }: {
  readonly turn: TurnSummary;
  readonly open: boolean;
  readonly onToggle: (id: string) => void;
}): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);
  return (
    <article className="overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--ema-surface-2)]"
        aria-expanded={open}
        onClick={() => onToggle(turn.id)}
      >
        <span className="i-lucide:rotate-cw shrink-0 text-base text-[var(--ema-primary)]" aria-hidden />
        <span className="min-w-0 flex-1">
          {/* Turn 没有标题字段. 这里显示自己的 ID, 不把用户消息截取后当成轮次标题. */}
          <Tooltip content={turn.id} variant="card">
            <strong className="block truncate text-sm">Turn · {turn.id.slice(0, 8)}</strong>
          </Tooltip>
          <span className="mt-1 block text-xs text-[var(--ema-text-tertiary)]">
            {fmtDateFull(turn.createdAt)} · {turn.messageCount} 消息 · {fmtTokens(turn.inputTokens + turn.outputTokens)} Token
          </span>
        </span>
        <span className="shrink-0 text-xs text-[var(--ema-text-secondary)]">{turnStatus(turn.status)}</span>
        <span
          className="i-lucide:chevron-down shrink-0 text-xs transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
          aria-hidden
        />
      </button>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {mounted && (
            <div className="flex flex-col gap-5 border-t border-[var(--ema-border)] px-4 py-4">
              {/* 三部分独立请求. 模型信息读取失败也不阻止目录先显示. */}
              <TurnRecord turnId={turn.id} />
              <MessageDetail sessionId={turn.sessionId} turnId={turn.id} />
              <ToolDetail turnId={turn.id} />
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

function TurnRecord({ turnId }: { readonly turnId: string }): JSX.Element {
  const [turn, setTurn] = useState<TurnDetailResult['turn'] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeSystemEvent(event => {
    if (
      (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
      && event.turnId === turnId
    ) {
      setRevision(current => current + 1);
    }
  }), [turnId]);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void turnsApi.get(turnId, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setTurn(result.turn);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setFailed(true);
      }
    });
    return () => controller.abort();
  }, [turnId, revision]);
  if (failed) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-xs text-[var(--ema-danger)]">轮次信息读取失败</p>
        <Button variant="ghost" size="sm" onClick={() => setRevision(current => current + 1)}>
          重试
        </Button>
      </div>
    );
  }
  if (!turn) {
    return <Skeleton className="h-24 rounded-lg" />;
  }
  let trigger: string;
  if (turn.triggerType === 'userMessage') {
    trigger = '用户输入';
  }
  else {
    trigger = '会话继续';
  }
  return (
    <section className="flex flex-col gap-3 text-xs" aria-label="轮次信息">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[var(--ema-text-tertiary)]">开始时间</p>
          <time>{fmtDateFull(turn.createdAt)}</time>
        </div>
        <div>
          <p className="mb-1 text-[var(--ema-text-tertiary)]">结束时间</p>
          {turn.completedAt === null ? (
            <span>未结束</span>
          ) : (
            <time>{fmtDateFull(turn.completedAt)}</time>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[var(--ema-text-secondary)] sm:grid-cols-2">
        <div>
          <dt className="text-[var(--ema-text-tertiary)]">模型</dt>
          <dd className="break-all">{turn.modelId ?? '未完成模型选择'}</dd>
        </div>
        <div>
          <dt className="text-[var(--ema-text-tertiary)]">供应商 / 协议</dt>
          <dd>{turn.providerId ?? '—'} / {turn.protocol ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-[var(--ema-text-tertiary)]">触发方式</dt>
          <dd>{trigger}</dd>
        </div>
        <div>
          <dt className="text-[var(--ema-text-tertiary)]">迭代次数</dt>
          <dd>{turn.iterations}</dd>
        </div>
      </dl>
      {turn.errorCode && (
        <p className="whitespace-pre-wrap break-words text-[var(--ema-danger)]">
          {turn.errorCode}{turn.errorMessage ? `: ${turn.errorMessage}` : ''}
        </p>
      )}
    </section>
  );
}

function turnStatus(status: TurnSummary['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '已停止';
  }
}
