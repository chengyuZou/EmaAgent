import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button, CodeViewer, Skeleton } from '@ema-agent/ui';
import { sessionsApi, type RawMessageHeader, type RawMessagesPage } from '../../../api/sessions.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';
import { fmtDateFull } from '../storageFormat.js';
import { useDetailPages } from '../useDetailPages.js';

const messageId = (message: RawMessageHeader): string => message.id;

interface MessageDetailProps {
  readonly sessionId: string;
  /** 指定时只展示这一轮的目录. 正文仍按单条 Message 读取. */
  readonly turnId?: string;
}

export function MessageDetail({ sessionId, turnId }: MessageDetailProps): JSX.Element {
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [openId, setOpenId] = useState<string | null>(null);
  const readPage = useCallback(async (before: RawMessagesPage['nextCursor'] | undefined, signal: AbortSignal) => {
    const page = await sessionsApi.listRawMessages(sessionId, {
      before: before ?? undefined,
      order,
      turnId,
      limit: 50,
    }, signal);
    return { items: page.messages, nextCursor: page.nextCursor };
  }, [sessionId, turnId, order]);
  const { items: messages, cursor, loading, loadingMore, failed, refresh, loadMore } = useDetailPages(readPage, messageId, order);

  useEffect(() => subscribeSystemEvent(event => {
    if (event.type === 'session_messages_changed' && event.sessionId === sessionId && !turnId) {
      refresh();
      return;
    }
    if (event.type !== 'turn_completed' && event.type !== 'turn_failed' && event.type !== 'turn_aborted') {
      return;
    }
    if (event.sessionId !== sessionId || (turnId && event.turnId !== turnId)) {
      return;
    }
    refresh();
  }), [sessionId, turnId, refresh]);

  const toggle = useCallback((id: string) => {
    setOpenId(current => current === id ? null : id);
  }, []);

  return (
    <section className="flex flex-col gap-2" aria-label="消息目录">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--ema-text-tertiary)]">消息目录 · 已加载 {messages.length} 条</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpenId(null);
            setOrder(current => current === 'asc' ? 'desc' : 'asc');
          }}
        >{order === 'asc' ? '正序' : '倒序'}</Button>
      </div>
      {failed && (
        <div className="flex items-center justify-center gap-2 py-3">
          <p className="text-xs text-[var(--ema-danger)]">消息读取失败</p>
          <Button variant="ghost" size="sm" onClick={refresh}>重试</Button>
        </div>
      )}
      {loading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : (
        <>
          {messages.length === 0 && !failed && (
            <p className="py-6 text-center text-xs text-[var(--ema-text-tertiary)]">没有消息记录</p>
          )}
          {messages.map(message => (
            <MessageRow
              key={message.id}
              sessionId={sessionId}
              message={message}
              turnId={turnId}
              open={openId === message.id}
              onToggle={toggle}
            />
          ))}
          {cursor && !failed && (
            <Button variant="ghost" size="sm" loading={loadingMore} onClick={loadMore}>
              {order === 'asc' ? '加载更晚的消息' : '加载更早的消息'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const MessageRow = memo(function MessageRow({ sessionId, turnId, message, open, onToggle }: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly message: RawMessageHeader;
  readonly open: boolean;
  readonly onToggle: (id: string) => void;
}): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);
  return (
    <div className="border-b border-[var(--ema-border)]">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 px-2 py-2 text-left hover:bg-[var(--ema-surface-2)]"
        onClick={() => onToggle(message.id)}
        aria-expanded={open}
      >
        <span className="text-xs text-[var(--ema-primary-text)]">{message.role}</span>
        <span className="text-xs text-[var(--ema-text-tertiary)]">{message.kind}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ema-text-secondary)]">{message.id}</span>
        <time className="text-xs text-[var(--ema-text-tertiary)]">{fmtDateFull(message.createdAt)}</time>
        <span className="i-lucide:chevron-down text-xs" style={{ transform: open ? 'rotate(180deg)' : undefined }} aria-hidden />
      </button>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div>
          {/* 收起动画结束后卸载正文, 不让展开过的 Base64 或长 JSON 常驻每一行. */}
          {mounted && <MessageBody sessionId={sessionId} turnId={turnId} messageId={message.id} />}
        </div>
      </div>
    </div>
  );
});

function MessageBody({ sessionId, turnId, messageId }: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly messageId: string;
}): JSX.Element {
  const [blocksJson, setBlocksJson] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const hasBody = useRef(false);
  const load = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(!hasBody.current);
    setFailed(false);
    void sessionsApi.getRawMessage(sessionId, messageId, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setBlocksJson(result.blocksJson);
          hasBody.current = true;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
  }, [sessionId, messageId]);

  useEffect(() => {
    load();
    return () => request.current?.abort();
  }, [load]);
  useEffect(() => subscribeSystemEvent(event => {
    if (
      (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted')
      && event.sessionId === sessionId
      && (turnId === undefined || event.turnId === turnId)
    ) {
      load();
    }
  }), [sessionId, turnId, load]);

  const pretty = useMemo(() => {
    if (blocksJson === null) {
      return null;
    }
    return JSON.stringify(JSON.parse(blocksJson), null, 2);
  }, [blocksJson]);

  if (loading) {
    return <Skeleton className="m-2 h-16 rounded-lg" />;
  }
  return (
    <div className="mx-2 mb-2">
      {failed && (
        <div className="flex items-center justify-center gap-2 py-3">
          <p className="text-xs text-[var(--ema-danger)]">消息正文读取失败</p>
          <Button variant="ghost" size="sm" onClick={load}>重试</Button>
        </div>
      )}
      {pretty !== null && (
        <CodeViewer source={pretty} language="json" />
      )}
    </div>
  );
}
