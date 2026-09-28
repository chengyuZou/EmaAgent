// 按单条可见 Message 虚拟化持久 History 与当前 Turn.
// 附近翻页在同一窗口内合并消息并保持视口, Turn 远跳则替换窗口并重建 Virtuoso.
// Message ID 负责跨更新识别同一条消息, 数组 index 只描述当前窗口内的位置.

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import {
  Virtuoso,
  type Components,
  type ContextProp,
  type ListProps,
  type VirtuosoHandle,
} from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { SessionMessage } from '@ema-agent/session';
import { charactersApi } from '../../api/characters.js';
import { fetchServerObjectUrl } from '../../lib/serverFileUrl.js';
import { useCharacterStore } from '../../stores/character.js';
import {
  useSessionActivityStore,
  type ActiveCompact,
} from '../../stores/sessionActivity.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useSessionStore } from '../../stores/session.js';
import {
  isStreamingMessage,
  useTurnStore,
  type StreamingMessage,
  type TurnState,
} from '../../stores/turn.js';
import { scheduleTurnHistoryClosure } from '../session/turnHistoryClosure.js';
import { TurnNavigationRail } from './TurnNavigationRail.js';
import { TurnFooter, type SessionTurnStats } from '../messages/TurnFooter.js';
import { UIMessage, toolResultsForMessages } from '../messages/UIMessage.js';

const MESSAGE_TOP_INSET = 40;
const PREPEND_ANCHOR_SETTLE_FRAMES = 4;

interface MessageListStatusProps {
  readonly loadingNewer: boolean;
  readonly error?: string;
  readonly stopReason?: string;
  readonly activeCompact: ActiveCompact | null;
}

interface MessageListContext extends MessageListStatusProps {
  readonly loadingOlder: boolean;
  readonly bottomInset: number;
}

interface MessageViewportAnchor {
  readonly messageId: string;
  readonly topOffsetPx: number;
}

// Virtuoso's absolute viewport ignores scroller padding, so gutters belong on the content layer.
const MessageListContent = forwardRef<HTMLDivElement, ListProps & ContextProp<MessageListContext>>(
  function MessageListContent({ context: _context, ...props }, ref): JSX.Element {
    return <div {...props} ref={ref} className="ema-chat-history-content-inset" />;
  },
);

function MessageListHeader({ context }: ContextProp<MessageListContext>): JSX.Element {
  return (
    <>
      <div aria-hidden style={{ height: MESSAGE_TOP_INSET }} />
      {context.loadingOlder && (
        <div className="ema-chat-history-content-inset py-2 text-center text-xs text-[var(--ema-text-tertiary)]">
          正在读取更早消息…
        </div>
      )}
    </>
  );
}

function MessageListFooter({ context }: ContextProp<MessageListContext>): JSX.Element {
  return (
    <>
      <div className="ema-chat-history-content-inset">
        <div className="ema-chat-content-column">
          <MessageListStatus {...context} />
        </div>
      </div>
      <div aria-hidden style={{ height: context.bottomInset }} />
    </>
  );
}

const MESSAGE_LIST_COMPONENTS: Components<SessionMessage | StreamingMessage, MessageListContext> = {
  List: MessageListContent,
  Header: MessageListHeader,
  Footer: MessageListFooter,
};

export function buildMessageList(
  historyMessages: readonly SessionMessage[],
  turns: ReadonlyMap<string, TurnState>,
): readonly (SessionMessage | StreamingMessage)[] {
  const activeTurnIds = new Set(turns.keys());
  const messages: (SessionMessage | StreamingMessage)[] = historyMessages.filter(message => (
    !message.turnId || !activeTurnIds.has(message.turnId)
  ));
  for (const turn of turns.values()) messages.push(...turn.messages);
  return messages.filter(isVisibleMessage);
}

export function messageListKey(message: SessionMessage | StreamingMessage): string {
  return message.id;
}

export function messageScrollLocation(index: number): Parameters<VirtuosoHandle['scrollToIndex']>[0] {
  return {
    index,
    align: 'start',
    behavior: 'auto',
    offset: -MESSAGE_TOP_INSET,
  };
}

export function MessageList({
  sessionId,
  bottomInset,
}: {
  readonly sessionId: string;
  readonly bottomInset: number | null;
}): JSX.Element {
  const listRef = useRef<VirtuosoHandle | null>(null);
  const pendingPrependAnchor = useRef<MessageViewportAnchor | null>(null);
  const history = useSessionHistoryStore(useShallow(state => {
    const value = state.bySession.get(sessionId);
    return {
      messages: value?.messages ?? EMPTY_HISTORY_MESSAGES,
      windowAnchorMessageId: value?.windowAnchorMessageId,
      turnStatsById: value?.turnStatsById ?? EMPTY_TURN_STATS,
      loaded: value?.loaded ?? false,
      loading: value?.loading ?? false,
      loadingOlder: value?.loadingOlder ?? false,
      loadingNewer: value?.loadingNewer ?? false,
      olderCursor: value?.olderCursor,
      newerCursor: value?.newerCursor,
      error: value?.error,
    };
  }));
  // around 的锚点属于窗口身份. 它变化时必须丢弃旧测量, 普通 prepend 不改变窗口身份.
  const windowId = `${sessionId}:${history.windowAnchorMessageId ?? ''}`;
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [visibleTurnIds, setVisibleTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const atBottom = useRef(false);
  const previousBottomInset = useRef(bottomInset);
  const attachScroller = useCallback((element: HTMLElement | Window | null): void => {
    setScrollerElement(element instanceof HTMLElement ? element : null);
  }, []);

  useLayoutEffect(() => {
    if (!scrollerElement) return;
    const chatColumn = scrollerElement.closest<HTMLElement>('[data-ema-chat-column]');
    if (!chatColumn) return;
    // The composer is outside the scroller and must reserve the same native scrollbar width.
    const measureScrollbar = (): void => {
      const width = scrollerElement.offsetWidth - scrollerElement.clientWidth;
      chatColumn.style.setProperty('--ema-chat-scrollbar-width', `${width}px`);
    };
    measureScrollbar();
    const observer = new ResizeObserver(measureScrollbar);
    observer.observe(scrollerElement);
    return () => {
      observer.disconnect();
      chatColumn.style.removeProperty('--ema-chat-scrollbar-width');
    };
  }, [scrollerElement]);
  const turns = useTurnStore(useShallow(state => (
    new Map(state.turnsBySession.get(sessionId) ?? [])
  )));
  const stopReason = useTurnStore(state => state.stopReasonBySession.get(sessionId));
  const activeCompact = useSessionActivityStore(
    state => state.bySession.get(sessionId)?.activeCompact ?? null,
  );

  useEffect(() => {
    void useSessionHistoryStore.getState().loadLatest(sessionId).then(() => {
      scheduleTurnHistoryClosure(sessionId);
    });
  }, [sessionId]);

  const messages = useMemo(
    () => buildMessageList(history.messages, turns),
    [history.messages, turns],
  );
  const allMessages = useMemo(
    () => collectOwnedMessages(history.messages, turns),
    [history.messages, turns],
  );
  const toolResults = useMemo(() => toolResultsForMessages(allMessages), [allMessages]);
  const messagesByTurn = useMemo(() => collectMessagesByTurn(allMessages), [allMessages]);

  useLayoutEffect(() => {
    const previous = previousBottomInset.current;
    previousBottomInset.current = bottomInset;
    if (
      bottomInset === null
      || previous === null
      || previous === bottomInset
      || !atBottom.current
      || history.windowAnchorMessageId
    ) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    });
    return () => cancelAnimationFrame(frame);
  }, [bottomInset, history.windowAnchorMessageId]);

  useLayoutEffect(() => {
    // 整窗替换不能继承上一窗口的 DOM 锚点, 即使两个窗口恰好包含同一条 Message.
    pendingPrependAnchor.current = null;
  }, [windowId]);

  useLayoutEffect(() => {
    const anchor = pendingPrependAnchor.current;
    if (!anchor || !scrollerElement) return;
    const index = messages.findIndex(message => message.id === anchor.messageId);
    if (index < 0) {
      pendingPrependAnchor.current = null;
      return;
    }

    let frame: number | null = null;
    let remainingFrames = PREPEND_ANCHOR_SETTLE_FRAMES;
    const settle = (): void => {
      if (pendingPrependAnchor.current !== anchor) return;
      const element = findMessageElement(scrollerElement, anchor.messageId);
      if (!element) {
        // 前插后旧锚点可能暂时不在挂载区. 先按新数组 index 定位, 再用 DOM 像素差校正.
        listRef.current?.scrollToIndex({
          index,
          align: 'start',
          behavior: 'auto',
          offset: -MESSAGE_TOP_INSET - anchor.topOffsetPx,
        });
      } else {
        // Virtuoso 会在定位后继续测量行高. 连续几帧补偿可避免估算高度造成可见文字跳动.
        const viewportTop = scrollerElement.getBoundingClientRect().top + MESSAGE_TOP_INSET;
        const currentOffset = element.getBoundingClientRect().top - viewportTop;
        const correction = currentOffset - anchor.topOffsetPx;
        if (Math.abs(correction) >= 0.5) scrollerElement.scrollTop += correction;
      }

      remainingFrames -= 1;
      if (remainingFrames <= 0) {
        pendingPrependAnchor.current = null;
        return;
      }
      frame = requestAnimationFrame(settle);
    };

    settle();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [history.messages, messages, scrollerElement, windowId]);

  useEffect(() => {
    if (!scrollerElement) return;
    let frame: number | null = null;
    const observedMessages = new Set<Element>();
    const scheduleMeasure = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const viewport = scrollerElement.getBoundingClientRect();
        const viewportTop = viewport.top + MESSAGE_TOP_INSET;
        const nextVisible = new Set<string>();
        let firstVisibleTurnId: string | undefined;
        const messagesInDom = scrollerElement.querySelectorAll<HTMLElement>('[data-turn-id]');
        const mountedMessages = new Set<Element>();
        for (const element of messagesInDom) {
          mountedMessages.add(element);
          if (!observedMessages.has(element)) {
            observedMessages.add(element);
            resizeObserver.observe(element);
          }
          const bounds = element.getBoundingClientRect();
          if (bounds.bottom <= viewportTop || bounds.top >= viewport.bottom) continue;
          const turnId = element.dataset.turnId;
          if (!turnId) continue;
          nextVisible.add(turnId);
          firstVisibleTurnId ??= turnId;
        }
        for (const element of observedMessages) {
          if (mountedMessages.has(element)) continue;
          resizeObserver.unobserve(element);
          observedMessages.delete(element);
        }
        setVisibleTurnIds(current => (
          current.size === nextVisible.size && [...current].every(id => nextVisible.has(id))
            ? current
            : nextVisible
        ));
        if (firstVisibleTurnId) {
          useSessionHistoryStore.getState().setCurrentTurn(sessionId, firstVisibleTurnId);
        }
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollerElement);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(scrollerElement, { childList: true, subtree: true });
    scrollerElement.addEventListener('scroll', scheduleMeasure, { passive: true });
    scheduleMeasure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scrollerElement.removeEventListener('scroll', scheduleMeasure);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [scrollerElement, sessionId, windowId]);

  async function selectTurn(turnId: string): Promise<void> {
    const item = useSessionHistoryStore.getState().bySession.get(sessionId)
      ?.turnIndexItems.find(candidate => candidate.turnId === turnId);
    if (!item?.anchorMessageId) return;
    const loadedIndex = messages.findIndex(message => message.id === item.anchorMessageId);
    if (loadedIndex >= 0) {
      // 当前窗口内跳转只使用局部数组 index, 不需要修改窗口或伪造全局虚拟编号.
      useSessionHistoryStore.getState().cancelPendingWindowReplace(sessionId);
      listRef.current?.scrollToIndex(messageScrollLocation(loadedIndex));
      return;
    }

    await useSessionHistoryStore.getState().openAround(sessionId, item.anchorMessageId);
  }

  async function loadOlder(): Promise<void> {
    const store = useSessionHistoryStore.getState();
    const before = store.bySession.get(sessionId);
    if (!before?.olderCursor || before.loadingOlder || pendingPrependAnchor.current) return;

    // 在 Store 合并旧页前保存用户眼前的 Message 和像素位置, 而不是保存会随 prepend 改变的 index.
    const anchor = scrollerElement
      ? captureMessageViewportAnchor(scrollerElement)
      : null;
    pendingPrependAnchor.current = anchor;
    const firstMessageId = before.messages[0]?.id;
    await store.loadOlder(sessionId);

    const after = useSessionHistoryStore.getState().bySession.get(sessionId);
    if (
      anchor
      && pendingPrependAnchor.current === anchor
      && after?.messages[0]?.id === firstMessageId
    ) {
      pendingPrependAnchor.current = null;
    }
  }

  const anchorIndex = history.windowAnchorMessageId
    ? messages.findIndex(message => message.id === history.windowAnchorMessageId)
    : -1;

  if (!history.loaded && history.loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm text-[var(--ema-text-tertiary)]"
        style={{ paddingBottom: bottomInset ?? 0 }}
      >
        正在读取消息…
      </div>
    );
  }
  if (messages.length === 0) {
    if (!history.error && !stopReason && !activeCompact) {
      return (
        <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: bottomInset ?? 0 }}>
          <ChatEmptyState sessionId={sessionId} />
        </div>
      );
    }
    return (
      <div
        className="ema-chat-history-inset flex flex-1 items-end justify-center"
        style={{ paddingBottom: (bottomInset ?? 0) + 16 }}
      >
        <MessageListStatus
          loadingNewer={history.loadingNewer}
          error={history.error}
          stopReason={stopReason}
          activeCompact={activeCompact}
        />
      </div>
    );
  }
  if (bottomInset === null) return <div className="min-h-0 flex-1" />;

  // Stable Message ID owns React and Virtuoso identity. The local index may change after prepend.
  return (
    <div className="relative flex-1 min-h-0">
      <TurnNavigationRail
        sessionId={sessionId}
        visibleTurnIds={visibleTurnIds}
        onSelectTurn={selectTurn}
      />
      <Virtuoso
        key={windowId}
        ref={listRef}
        scrollerRef={attachScroller}
        className="absolute inset-0 overflow-x-hidden"
        data={messages}
        computeItemKey={(_index, message) => messageListKey(message)}
        alignToBottom={!history.windowAnchorMessageId}
        followOutput={turns.size > 0 || activeCompact !== null ? 'auto' : false}
        initialTopMostItemIndex={anchorIndex >= 0
          ? messageScrollLocation(anchorIndex)
          : { index: 'LAST', align: 'end' }}
        atBottomStateChange={(value) => { atBottom.current = value; }}
        startReached={() => {
          if (history.olderCursor) void loadOlder();
        }}
        endReached={() => {
          if (history.newerCursor) void useSessionHistoryStore.getState().loadNewer(sessionId);
        }}
        context={{
          loadingOlder: history.loadingOlder,
          loadingNewer: history.loadingNewer,
          error: history.error,
          stopReason: turns.size === 0 ? stopReason : undefined,
          activeCompact,
          bottomInset,
        }}
        components={MESSAGE_LIST_COMPONENTS}
        itemContent={(index, message) => {
          const turnId = message.turnId;
          const next = messages[index + 1];
          const endsTurn = Boolean(turnId && next?.turnId !== turnId);
          const turn = turnId ? turns.get(turnId) : undefined;
          return (
            <div
              className="ema-chat-content-column py-1.5"
              data-message-id={message.id}
              data-turn-id={turnId ?? undefined}
            >
              <UIMessage
                message={message}
                sessionId={sessionId}
                toolResults={toolResults}
                terminal={turn?.terminal ?? true}
              />
              {endsTurn && turnId && (
                <TurnFooter
                  sessionId={sessionId}
                  turnId={turnId}
                  messages={messagesByTurn.get(turnId) ?? []}
                  turnStats={history.turnStatsById.get(turnId)}
                  canFork={!turn}
                />
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

function captureMessageViewportAnchor(scrollerElement: HTMLElement): MessageViewportAnchor | null {
  const viewport = scrollerElement.getBoundingClientRect();
  const viewportTop = viewport.top + MESSAGE_TOP_INSET;
  // 选择内容视口内第一条实际可见行, Header 占用的顶部 inset 不属于阅读位置.
  const messages = scrollerElement.querySelectorAll<HTMLElement>('[data-message-id]');
  for (const element of messages) {
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom <= viewportTop || bounds.top >= viewport.bottom) continue;
    const messageId = element.dataset.messageId;
    if (!messageId) continue;
    return {
      messageId,
      topOffsetPx: bounds.top - viewportTop,
    };
  }
  return null;
}

function findMessageElement(
  scrollerElement: HTMLElement,
  messageId: string,
): HTMLElement | undefined {
  const messages = scrollerElement.querySelectorAll<HTMLElement>('[data-message-id]');
  return [...messages].find(element => element.dataset.messageId === messageId);
}

function collectOwnedMessages(
  historyMessages: readonly SessionMessage[],
  turns: ReadonlyMap<string, TurnState>,
): readonly (SessionMessage | StreamingMessage)[] {
  const activeTurnIds = new Set(turns.keys());
  const messages: (SessionMessage | StreamingMessage)[] = historyMessages.filter(message => (
    !message.turnId || !activeTurnIds.has(message.turnId)
  ));
  for (const turn of turns.values()) messages.push(...turn.messages);
  return messages;
}

function collectMessagesByTurn(
  messages: readonly (SessionMessage | StreamingMessage)[],
): ReadonlyMap<string, readonly (SessionMessage | StreamingMessage)[]> {
  const byTurn = new Map<string, (SessionMessage | StreamingMessage)[]>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const current = byTurn.get(message.turnId);
    if (current) current.push(message);
    else byTurn.set(message.turnId, [message]);
  }
  return byTurn;
}

function isVisibleMessage(message: SessionMessage | StreamingMessage): boolean {
  return isStreamingMessage(message)
    || message.kind === 'normal'
    || message.kind === 'summary';
}

function MessageListStatus({
  loadingNewer,
  error,
  stopReason,
  activeCompact,
}: MessageListStatusProps): JSX.Element {
  const [compactElapsedSeconds, setCompactElapsedSeconds] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = activeCompact?.startedAt;
    if (startedAt === null || startedAt === undefined) {
      setCompactElapsedSeconds(null);
      return;
    }
    const updateElapsed = (): void => {
      setCompactElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [activeCompact]);

  return (
    <div className="flex min-h-4 flex-col items-center gap-2 py-2">
      {activeCompact && (
        <div className="ema-chat-content-column">
          {compactElapsedSeconds !== null && (
            <div className="border-b border-[var(--ema-border)] px-3 py-2 text-xs text-[var(--ema-text-tertiary)]">
              已处理 {compactElapsedSeconds}秒
            </div>
          )}
          <div
            role="status"
            className="ema-shimmer flex items-center gap-2 px-3 py-2 text-xs text-[var(--ema-text-secondary)]"
          >
            <span className="i-ema:context-compact size-3.5 shrink-0 text-[var(--ema-primary)]" aria-hidden />
            <span>正在压缩上下文…</span>
          </div>
        </div>
      )}
      {loadingNewer && (
        <div className="text-xs text-[var(--ema-text-tertiary)]">正在读取更新消息…</div>
      )}
      {error && (
        <span className="rounded-full bg-[var(--ema-danger-muted)] px-4 py-1.5 text-xs text-[var(--ema-danger)]">
          {error}
        </span>
      )}
      {stopReason && (
        <span className="rounded-full bg-[var(--ema-surface-2)] px-4 py-1.5 text-xs text-[var(--ema-text-tertiary)]">
          {stopReason}
        </span>
      )}
    </div>
  );
}

const EMPTY_TURN_STATS: ReadonlyMap<string, SessionTurnStats> = new Map();
const EMPTY_HISTORY_MESSAGES: readonly SessionMessage[] = [];

function ChatEmptyState({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const characterName = useCharacterStore(state => state.activeName);
  const character = useCharacterStore(state => state.characters.find(item => item.name === state.activeName));
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd ?? null);
  const projectName = useSessionStore(state => {
    const projectId = state.sessions.byId.get(sessionId)?.projectId;
    if (!projectId) return null;
    return [...state.sessions.pinnedProjects, ...state.sessions.projects]
      .find(item => item.id === projectId)?.name ?? null;
  });
  const [illustrationUrl, setIllustrationUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!characterName) {
      setIllustrationUrl(null);
      return;
    }
    let mounted = true;
    let objectUrl: string | null = null;
    void charactersApi.presentation(characterName)
      .then(async presentation => presentation.status === 'illustration'
        ? fetchServerObjectUrl(charactersApi.illustrationFileUrl(characterName, presentation.resource.name))
        : null)
      .then(url => {
        if (!mounted) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setIllustrationUrl(url);
      })
      .catch(() => {
        if (mounted) setIllustrationUrl(null);
      });
    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [characterName]);

  const locationName = projectName ?? cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <div className="ema-empty-state">
      <div className="ema-empty-state-glow ema-fade-in" aria-hidden />
      {illustrationUrl ? (
        <img
          className="ema-empty-state-avatar ema-stagger-in"
          style={{ '--stagger-i': 0 } as CSSProperties}
          src={illustrationUrl}
          alt={character?.name ?? '角色'}
          draggable={false}
        />
      ) : (
        <div
          className="ema-empty-state-avatar ema-empty-state-avatar-fallback ema-stagger-in"
          style={{ '--stagger-i': 0 } as CSSProperties}
          aria-hidden
        >
          <span className="i-lucide:paw-print" />
        </div>
      )}
      <h2
        className="ema-empty-state-title ema-stagger-in"
        style={{ '--stagger-i': 1 } as CSSProperties}
      >
        {character ? `和 ${character.name} 开始聊天` : '开始聊天吧'}
      </h2>
      {locationName && (
        <div
          className="ema-empty-state-chip ema-stagger-in"
          style={{ '--stagger-i': 2 } as CSSProperties}
        >
          <span className="i-lucide:folder" aria-hidden />
          {locationName}
        </div>
      )}
    </div>
  );
}
