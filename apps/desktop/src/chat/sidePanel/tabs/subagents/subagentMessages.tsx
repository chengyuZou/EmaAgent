// 同一子代理的全部消息连续阅读. HTTP 与实时消息按 SQL MessageId 合并, 不按 Run 切换窗口.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SubagentMessage } from '@ema-agent/agent';
import type { ToolResult } from '@ema-agent/tools';
import { Button, IconButton, Spinner } from '@ema-agent/ui';
import { subagentsApi, type SubagentMessageCursor } from '../../../../api/subagents.js';
import { useSubagentStore } from '../../../../stores/subagent.js';
import { useSessionActivityStore } from '../../../../stores/sessionActivity.js';
import { useThemeStore } from '../../../../stores/theme.js';
import type { AssistantOutputBlock } from '../../../../stores/turn.js';
import { UIMessage, toolResultsForMessages } from '../../../messages/UIMessage.js';
import { MessageExpansionContext } from '../../../messages/messageExpansion.js';

const NO_MESSAGES: readonly SubagentMessage[] = [];
const TOP_INSET = 24;

type ReadingPosition =
  | { readonly kind: 'latest' }
  | { readonly kind: 'message'; readonly messageId: string; readonly offset: number };

/** 旧窗口只更新已加载的 ID, 不越过未加载的 newer 历史接入最新消息. */
export function collectSubagentMessages(history: readonly SubagentMessage[], live: readonly SubagentMessage[], reachesLatest: boolean): readonly SubagentMessage[] {
  const byId = new Map(history.map(message => [message.id, message]));
  const first = history[0];

  for (const message of live) {
    const belongsToLatestWindow = reachesLatest
      && (
        !first
        || message.createdAt > first.createdAt
        || (message.createdAt === first.createdAt && message.id >= first.id)
      );
    if (belongsToLatestWindow || byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  return [...byId.values()].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
}

export function SubagentMessages({ subagentId, sessionId }: { readonly subagentId: string; readonly sessionId: string }): JSX.Element {
  const [history, setHistory] = useState<readonly SubagentMessage[]>([]);
  const [older, setOlder] = useState<SubagentMessageCursor | null>(null);
  const [newer, setNewer] = useState<SubagentMessageCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestRequest, setLatestRequest] = useState(0);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const target = useRef<ReadingPosition | null>(null);
  const expansions = useRef(new Map<string, Map<string, boolean>>());
  const initialized = useRef(false);
  const layoutChanged = useRef(false);
  const previouslyLatest = useRef(false);
  const atBottomRef = useRef(true);
  const newerRef = useRef(newer);
  const readingFont = useThemeStore(state => state.readingFont);
  const codeFont = useThemeStore(state => state.codeFont);
  const [, requestPositionCommit] = useState(0);
  const live = useSubagentStore(state => (
    state.streamingMessages.get(subagentId) ?? NO_MESSAGES
  ));
  const activeRun = useSubagentStore(state => state.progressById.get(subagentId)?.runId);
  const owned = useMemo(
    () => collectSubagentMessages(history, live, loaded && !newer),
    [history, live, loaded, newer],
  );
  const messages = useMemo(
    () => owned.filter(message => message.kind === 'normal' || message.kind === 'summary'),
    [owned],
  );
  const results = useMemo(() => toolResultsForMessages(owned), [owned]);
  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scroller,
    getItemKey,
    estimateSize: index => {
      const message = messages[index]!;
      if (message.kind === 'summary') {
        return 56;
      }
      const text = typeof message.blocks === 'string'
        ? message.blocks
        : message.blocks
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');
      return Math.min(1_000, 96 + Math.ceil(text.length / 90) * 22);
    },
    overscan: 5,
    anchorTo: 'end',
    followOnAppend: previouslyLatest.current && loaded && !newer,
    scrollEndThreshold: 24,
    paddingStart: TOP_INSET,
    paddingEnd: 32,
  });

  useLayoutEffect(() => {
    previouslyLatest.current = loaded && !newer;
    newerRef.current = newer;
  }, [loaded, newer]);

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    busy.current = true;
    initialized.current = false;
    setLoading(true);
    setLoaded(false);
    setHistory([]);
    setOlder(null);
    setNewer(null);
    target.current = null;
    setError(null);

    void subagentsApi.listMessages(
      subagentId,
      undefined,
      'before',
      controller.signal
    )
      .then(page => {
        if (controller.signal.aborted) {
          return;
        }
        setHistory(page.items);
        setOlder(page.olderCursor);
        setNewer(page.newerCursor);
        target.current = { kind: 'latest' };
        setLoaded(true);
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          busy.current = false;
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [subagentId, latestRequest]);

  useLayoutEffect(() => {
    if (!loaded || !scroller || messages.length === 0) {
      return;
    }
    if (layoutChanged.current) {
      layoutChanged.current = false;
      virtualizer.scrollToOffset(scroller.scrollTop);
      virtualizer.measure();
      virtualizer.getTotalSize();
      for (const node of virtualizer.elementsCache.values()) {
        virtualizer.measureElement(node);
      }
      virtualizer.getTotalSize();
    }

    const position = target.current;
    if (!position) {
      return;
    }
    if (position.kind === 'latest') {
      virtualizer.scrollToEnd();
    } else {
      const index = messages.findIndex(message => message.id === position.messageId);
      const row = virtualizer.measurementsCache[index];
      if (row) {
        virtualizer.scrollToOffset(row.start + position.offset);
      }
    }
    target.current = null;
    initialized.current = true;
  });

  useEffect(() => {
    if (!scroller) {
      return;
    }
    let previousWidth = scroller.clientWidth;
    let previousHeight = scroller.clientHeight;
    let frame: number | null = null;

    const rememberReadingPosition = (): void => {
      if (!initialized.current || target.current) {
        return;
      }
      if (atBottomRef.current && !newerRef.current) {
        target.current = { kind: 'latest' };
        return;
      }
      const row = virtualizer.getVirtualItemForOffset(scroller.scrollTop + TOP_INSET);
      if (row) {
        target.current = { kind: 'message', messageId: String(row.key), offset: scroller.scrollTop - row.start };
      }
    };
    const invalidate = (): void => {
      rememberReadingPosition();
      layoutChanged.current = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        requestPositionCommit(value => value + 1);
      });
    };
    const measure = (): void => {
      const width = scroller.clientWidth;
      const height = scroller.clientHeight;
      if (width === previousWidth && height === previousHeight) {
        return;
      }
      previousWidth = width;
      previousHeight = height;
      invalidate();
    };
    const cancelRestore = (): void => {
      target.current = null;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    document.fonts?.addEventListener('loadingdone', invalidate);
    scroller.addEventListener('wheel', cancelRestore, { passive: true });
    scroller.addEventListener('pointerdown', cancelRestore);
    scroller.addEventListener('keydown', cancelRestore);
    invalidate();

    return () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      document.fonts?.removeEventListener('loadingdone', invalidate);
      scroller.removeEventListener('wheel', cancelRestore);
      scroller.removeEventListener('pointerdown', cancelRestore);
      scroller.removeEventListener('keydown', cancelRestore);
    };
  }, [scroller, virtualizer, readingFont, codeFont]);

  async function loadPage(direction: 'before' | 'after'): Promise<void> {
    const cursor = direction === 'before' ? older : newer;
    if (!cursor || busy.current) {
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    setLoading(true);
    setError(null);

    try {
      const page = await subagentsApi.listMessages(
        subagentId,
        cursor,
        direction,
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      setHistory(current => {
        const byId = new Map(current.map(message => [message.id, message]));
        for (const message of page.items) {
          byId.set(message.id, message);
        }
        return [...byId.values()].sort((left, right) => (
          left.createdAt - right.createdAt || left.id.localeCompare(right.id)
        ));
      });
      if (direction === 'before') {
        setOlder(page.olderCursor);
      } else {
        setNewer(page.newerCursor);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setLoading(false);
      }
    }
  }

  function checkPagination(): void {
    if (!scroller || !loaded || busy.current || target.current || error) {
      return;
    }
    const threshold = Math.max(80, scroller.clientHeight * 0.35);
    if (newer && virtualizer.getDistanceFromEnd() < threshold) {
      void loadPage('after');
    } else if (older && scroller.scrollTop < threshold) {
      void loadPage('before');
    }
  }

  // 初始页只有内部消息时, 继续补页, 不要求用户先产生一次滚动.
  useEffect(() => {
    checkPagination();
  });

  return (
    <section className="relative flex min-h-0 flex-1 flex-col">
      {(loading || error) && (
        <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs" role="status">
          {loading && <Spinner size="sm" />}
          {error && (
            <>
              <span className="ema-subagent-error">读取子代理消息失败: {error}</span>
              <Button size="sm" variant="ghost" onClick={() => setLatestRequest(value => value + 1)}>
                重试
              </Button>
            </>
          )}
        </div>
      )}
      <div
        ref={setScroller}
        className="ema-chat-history-scroller relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        tabIndex={0}
        aria-label="子代理消息"
        onScroll={() => {
          const followsBottom = virtualizer.isAtEnd(24);
          atBottomRef.current = followsBottom;
          setAtBottom(followsBottom);
          checkPagination();
        }}
      >
        {older && (
          <Button
            className="absolute left-1/2 top-0 z-10 -translate-x-1/2"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void loadPage('before')}
          >
            更早消息
          </Button>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map(row => {
            const message = messages[row.index]!;
            let choices = expansions.current.get(message.id);
            if (!choices) {
              choices = new Map();
              expansions.current.set(message.id, choices);
            }
            return (
              <div
                key={message.id}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="ema-chat-history-content-inset"
                style={{ position: 'absolute', top: row.start, width: '100%' }}
              >
                <div className="ema-chat-content-column ema-chat-message-row" data-message-id={message.id}>
                  <MessageExpansionContext.Provider value={choices}>
                    <SubagentMessageView
                      message={message}
                      sessionId={sessionId}
                      results={results}
                      active={message.runId !== null && message.runId === activeRun}
                    />
                  </MessageExpansionContext.Provider>
                </div>
              </div>
            );
          })}
        </div>
        {!loading && loaded && messages.length === 0 && !older && !error && (
          <p className="ema-subagent-empty py-8">暂无可显示的消息</p>
        )}
      </div>
      <IconButton
        label="回到最新消息"
        icon="i-lucide:arrow-down"
        variant="ghost"
        size="sm"
        className="ema-chat-jump-latest"
        data-visible={!atBottom || Boolean(newer)}
        aria-hidden={atBottom && !newer}
        tabIndex={atBottom && !newer ? -1 : 0}
        disabled={atBottom && !newer}
        style={{ bottom: 16 }}
        onClick={() => {
          if (newer) {
            setLatestRequest(value => value + 1);
          } else {
            virtualizer.scrollToEnd({ behavior: 'smooth' });
          }
        }}
      />
    </section>
  );
}

function SubagentMessageView({
  message,
  sessionId,
  results,
  active,
}: {
  readonly message: SubagentMessage;
  readonly sessionId: string;
  readonly results: ReadonlyMap<string, ToolResult>;
  readonly active: boolean;
}): JSX.Element {
  const open = useSubagentStore(state => state.openMessageIds.has(message.id));
  const progress = useSubagentStore(state => state.toolProgress);
  const pending = useSessionActivityStore(state => (
    state.bySession.get(sessionId)?.pendingInteractions
  ));
  const blocks = useMemo(() => {
    const output: AssistantOutputBlock[] = [];
    if (message.role !== 'assistant' || !Array.isArray(message.blocks)) {
      return output;
    }
    for (const [index, block] of message.blocks.entries()) {
      if (block.type === 'text') {
        output.push({ type: 'text', blockIndex: index, text: block.text });
      } else if (block.type === 'thinking') {
        output.push({ type: 'thinking', blockIndex: index, thinking: block.thinking, done: !open });
      } else if (block.type === 'reasoning' || block.type === 'gemini_thought') {
        const thinking = block.type === 'reasoning' ? block.summaryText ?? '' : block.text;
        output.push({ type: 'thinking', blockIndex: index, thinking, done: !open });
      } else if (block.type === 'tool_use') {
        const result = results.get(block.id);
        const permissionPending = pending?.some(item => (
          item.kind === 'permission' && item.request.toolCallId === block.id
        )) ?? false;
        let status: Extract<AssistantOutputBlock, { type: 'tool_use' }>['status'] = 'interrupted';
        if (result) {
          status = result.isError ? 'failed' : 'succeeded';
        } else if (permissionPending) {
          status = 'awaiting_permission';
        } else if (active) {
          status = 'running';
        }
        const error = result?.isError
          ? {
            code: result.errorCode ?? 'tool/error',
            message: typeof result.content === 'string' ? result.content : '工具执行失败',
          }
          : undefined;
        output.push({
          type: 'tool_use',
          blockIndex: index,
          callId: block.id,
          name: block.name,
          args: block.args,
          startedAt: message.createdAt,
          status,
          permissionPending,
          progress: progress.get(block.id),
          output: result?.data ?? result?.content,
          error,
          durationMs: result?.durationMs,
        });
      }
    }
    return output;
  }, [message, results, open, active, pending, progress]);

  return (
    <UIMessage
      message={message}
      sessionId={sessionId}
      toolResults={results}
      terminal={!active}
      streamingBlocks={active || open ? blocks : undefined}
    />
  );
}
