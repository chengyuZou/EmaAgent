// Store 管历史窗口, 此处管分页与消息展示; 行高由内核测量, 定位交给共用视口逻辑.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { IconButton, Tooltip } from '@ema-agent/ui';
import type { SessionMessage, SessionUserBlock } from '@ema-agent/session';
import type { QueuedSessionInput } from '@ema-agent/turn';
import { emptyChatDraft, useChatDraftStore } from '../../stores/chatDraft.js';
import { ConversationStarters } from '../conversationStarters.js';
import { useSessionActivityStore, type ActiveCompact } from '../../stores/sessionActivity.js';
import { EMPTY_SESSION_HISTORY, useSessionHistoryStore, type SessionHistoryState } from '../../stores/sessionHistory.js';
import { isStreamingMessage, useTurnStore, type StreamingMessage, type TurnState } from '../../stores/turn.js';
import { scheduleTurnHistoryClosure } from '../session/turnHistoryClosure.js';
import { TurnNavigationRail } from './TurnNavigationRail.js';
import { TurnFooter } from '../messages/TurnFooter.js';
import { UIMessage, toolResultsForMessages } from '../messages/UIMessage.js';
import { UserMessage } from '../messages/UserMessage.js';
import { MessageExpansionContext } from '../messages/messageExpansion.js';
import { useMessageViewport } from './useMessageViewport.js';
import { sessionsApi } from '../../api/sessions.js';
import { MainView, useMainNavigationStore, type TurnNavigationRequest } from '../../layout/navigation.js';
import { showToast } from '../../lib/notifications/toast.js';
import { usePlaybackStore } from '../speech/turnSpeechPlayback.js';

const MESSAGE_TOP_INSET = 40;
const PLAYBACK_TARGET_HIGHLIGHT_MS = 1_800;
type OwnedMessage = SessionMessage | StreamingMessage;
interface PendingInputMessage {
  readonly type: 'queued_input';
  readonly id: string;
  readonly turnId: null;
  readonly blocks: SessionUserBlock[];
  readonly createdAt: number;
}
type DisplayMessage = OwnedMessage | PendingInputMessage;
const EMPTY_QUEUED_INPUTS: readonly QueuedSessionInput[] = [];

function isPendingInput(message: DisplayMessage): message is PendingInputMessage {
  return 'type' in message && message.type === 'queued_input';
}

/** 缺口窗口只更新已有 Message, 不能把最新 Turn 接到旧历史后面. */
export function collectOwnedMessages(
  history: readonly SessionMessage[],
  turns: ReadonlyMap<string, TurnState>,
  reachesLatest: boolean,
): readonly OwnedMessage[] {
  const byId = new Map<string, OwnedMessage>(history.map(message => [message.id, message]));
  for (const turn of turns.values()) {
    for (const message of turn.messages) {
      if (reachesLatest || byId.has(message.id)) byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function isVisibleMessage(message: OwnedMessage): boolean {
  return isStreamingMessage(message) || message.kind === 'normal' || message.kind === 'summary';
}

export function collectDisplayMessages(
  ownedMessages: readonly OwnedMessage[],
  queuedInputs: readonly QueuedSessionInput[],
  reachesLatest: boolean,
): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = ownedMessages.filter(isVisibleMessage);
  if (reachesLatest) {
    for (const item of queuedInputs) {
      if (item.delivery !== 'next_iteration') continue;
      messages.push({
        type: 'queued_input',
        id: item.id,
        turnId: null,
        blocks: item.input.map(part => part.type === 'attachment' ? part.block : part),
        createdAt: item.createdAt,
      });
    }
  }
  return messages;
}

function estimateMessageHeight(message: DisplayMessage): number {
  if (!isPendingInput(message) && !isStreamingMessage(message) && message.kind === 'summary') return 56;
  let textLength = 0;
  if (typeof message.blocks === 'string') textLength = message.blocks.length;
  else {
    for (const block of message.blocks) {
      if (block.type === 'text') textLength += block.text.length;
    }
  }
  // 只是挂载前的粗占位, 不是固定行高或文字排版预测.
  if (textLength === 0) return 112;
  return Math.min(1_000, 96 + Math.ceil(textLength / 90) * 22);
}

export function MessageList({ sessionId, bottomInset, latestButtonBottom }: {
  readonly sessionId: string;
  readonly bottomInset: number | null;
  readonly latestButtonBottom: number | null;
}): JSX.Element {
  const history = useSessionHistoryStore(state => state.bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY);
  const turns = useTurnStore(useShallow(state => new Map(state.turnsBySession.get(sessionId) ?? [])));
  const activeCompact = useSessionActivityStore(state => state.bySession.get(sessionId)?.activeCompact ?? null);
  const queuedInputs = useSessionActivityStore(state => state.bySession.get(sessionId)?.queuedInputs ?? EMPTY_QUEUED_INPUTS);
  const handledNavigationRequest = useRef<TurnNavigationRequest | null>(null);
  const [locatedPlaybackTurnId, setLocatedPlaybackTurnId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const highlightPlaybackTurn = useCallback((turnId: string): void => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    setLocatedPlaybackTurnId(turnId);
    highlightTimer.current = window.setTimeout(() => {
      setLocatedPlaybackTurnId(null);
      highlightTimer.current = null;
    }, PLAYBACK_TARGET_HIGHLIGHT_MS);
  }, []);

  useEffect(() => {
    setLocatedPlaybackTurnId(null);
    return () => {
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    void useSessionHistoryStore.getState().loadLatest(sessionId).then(() => scheduleTurnHistoryClosure(sessionId));
  }, [sessionId]);
  const ownedMessages = useMemo(
    () => collectOwnedMessages(history.messages, turns, !history.newerCursor),
    [history.messages, history.newerCursor, turns],
  );
  const messages = useMemo(
    () => collectDisplayMessages(ownedMessages, queuedInputs, !history.newerCursor),
    [ownedMessages, queuedInputs, history.newerCursor],
  );
  const toolResults = useMemo(() => toolResultsForMessages(ownedMessages), [ownedMessages]);
  const messagesByTurn = useMemo(() => {
    const byTurn = new Map<string, OwnedMessage[]>();
    for (const message of ownedMessages) {
      if (!message.turnId) continue;
      const current = byTurn.get(message.turnId);
      if (current) current.push(message);
      else byTurn.set(message.turnId, [message]);
    }
    return byTurn;
  }, [ownedMessages]);
  if (bottomInset === null) return <div className="min-h-0 flex-1" />;
  return (
    <HistoryViewport
      key={sessionId + ':' + (history.windowId ?? 'unloaded')}
      sessionId={sessionId} history={history} messages={messages} turns={turns}
      toolResults={toolResults} messagesByTurn={messagesByTurn}
      activeCompact={activeCompact} bottomInset={bottomInset} latestButtonBottom={latestButtonBottom}
      handledNavigationRequest={handledNavigationRequest}
      locatedPlaybackTurnId={locatedPlaybackTurnId}
      onPlaybackTurnLocated={highlightPlaybackTurn}
    />
  );
}

function HistoryViewport({
  sessionId, history, messages, turns, toolResults, messagesByTurn,
  activeCompact, bottomInset, latestButtonBottom, handledNavigationRequest,
  locatedPlaybackTurnId, onPlaybackTurnLocated,
}: {
  readonly sessionId: string;
  readonly history: SessionHistoryState;
  readonly messages: readonly DisplayMessage[];
  readonly turns: ReadonlyMap<string, TurnState>;
  readonly toolResults: ReturnType<typeof toolResultsForMessages>;
  readonly messagesByTurn: ReadonlyMap<string, readonly OwnedMessage[]>;
  readonly activeCompact: ActiveCompact | null;
  readonly bottomInset: number;
  readonly latestButtonBottom: number | null;
  readonly handledNavigationRequest: MutableRefObject<TurnNavigationRequest | null>;
  readonly locatedPlaybackTurnId: string | null;
  readonly onPlaybackTurnLocated: (turnId: string) => void;
}): JSX.Element {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const playbackKey = usePlaybackStore(state => state.playbackStatus ? state.queue[0] : undefined);
  const navigationRequest = useMainNavigationStore(state => state.turnNavigationRequest);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const [statusHeight, setStatusHeight] = useState(32);
  const [visibleTurnIds, setVisibleTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const scrollDirection = useRef<'older' | 'newer'>('older');
  const lastScrollTop = useRef(0);
  const expansionByMessage = useRef(new Map<string, Map<string, boolean>>());
  const knownMessageIds = useRef(new Set(messages.map(message => message.id)));
  const previouslyReachedLatest = useRef(!history.newerCursor);
  const followsNewMessages = previouslyReachedLatest.current && !history.newerCursor;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const viewport = useMessageViewport({
    messages,
    scroller,
    windowKey: history.windowId ?? 'unloaded',
    ready: history.loaded && !history.loading,
    reachesLatest: !history.newerCursor,
    initialMessageId: history.windowAnchorMessageId,
    estimateSize: index => estimateMessageHeight(messages[index]!),
    paddingStart: MESSAGE_TOP_INSET,
    paddingEnd: bottomInset + statusHeight,
  });
  const { virtualizer, atBottom: isAtBottom } = viewport;
  const totalHeight = virtualizer.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    for (const message of messages) {
      if (knownMessageIds.current.has(message.id) || !followsNewMessages || history.loading) continue;
      const turn = message.turnId ? turns.get(message.turnId) : undefined;
      if (!isPendingInput(message)
        && (!turn || turn.terminal || !turn.messages.some(item => item.id === message.id))) continue;
      // 只在新消息到达的这一提交播放. 没挂载的消息不会在后来滚入视口时补播.
      const row = virtualizer.elementsCache.get(message.id)?.querySelector('.ema-chat-message-row');
      row?.classList.add('ema-chat-message-enter');
    }
    knownMessageIds.current = new Set(messages.map(message => message.id));
  }, [messages, turns, followsNewMessages, history.loading, virtualizer]);

  useLayoutEffect(() => {
    previouslyReachedLatest.current = !history.newerCursor;
  }, [history.newerCursor]);

  useEffect(() => {
    const retained = new Set(messages.map(message => message.id));
    for (const id of expansionByMessage.current.keys()) {
      if (!retained.has(id)) expansionByMessage.current.delete(id);
    }
  }, [messages]);

  useLayoutEffect(() => {
    const status = statusRef.current;
    if (!status) return;
    const measure = (): void => {
      const next = Math.ceil(status.getBoundingClientRect().height);
      setStatusHeight(current => current === next ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(status);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!scroller) return;
    const column = scroller.closest<HTMLElement>('[data-ema-chat-column]');
    const measureScrollbar = (): void => {
      column?.style.setProperty('--ema-chat-scrollbar-width', String(scroller.offsetWidth - scroller.clientWidth) + 'px');
    };
    const observer = new ResizeObserver(measureScrollbar);
    observer.observe(scroller);
    measureScrollbar();
    return () => {
      observer.disconnect();
      column?.style.removeProperty('--ema-chat-scrollbar-width');
    };
  }, [scroller]);

  function checkPagination(): void {
    const state = useSessionHistoryStore.getState().bySession.get(sessionId);
    if (!state?.loaded || state.loading || state.loadingOlder || state.loadingNewer) return;
    const empty = messagesRef.current.length === 0;
    if (!empty && (viewport.isPositioning() || !scroller)) return;
    const threshold = Math.max(80, (scroller?.clientHeight ?? 0) * 0.35);
    const needsOlder = Boolean(state.olderCursor && !state.olderError
      && (empty || (scroller && scroller.scrollTop <= threshold)));
    const needsNewer = Boolean(state.newerCursor && !state.newerError
      && (empty || virtualizer.getDistanceFromEnd() <= threshold));
    const store = useSessionHistoryStore.getState();
    if (needsNewer && (!needsOlder || scrollDirection.current === 'newer')) void store.loadNewer(sessionId);
    else if (needsOlder) void store.loadOlder(sessionId);
  }

  useEffect(() => { checkPagination(); });

  // overscan 挂载不等于正在阅读, 导航轨只高亮与视口实际相交的行.
  useEffect(() => {
    if (!scroller) return;
    const top = scroller.scrollTop + MESSAGE_TOP_INSET;
    const bottom = scroller.scrollTop + scroller.clientHeight;
    const visible = new Set<string>();
    for (const row of virtualizer.getVirtualItems()) {
      if (row.end <= top || row.start >= bottom) continue;
      const turnId = messages[row.index]?.turnId;
      if (turnId) visible.add(turnId);
    }
    setVisibleTurnIds(current => current.size === visible.size && [...current].every(id => visible.has(id)) ? current : visible);
    const first = visible.values().next().value;
    if (first) useSessionHistoryStore.getState().setCurrentTurn(sessionId, first);
  }, [scroller, messages, virtualizer, virtualizer.scrollOffset, totalHeight]);

  async function selectTurn(turnId: string, isCurrentRequest: () => boolean = () => true): Promise<void> {
    const store = useSessionHistoryStore.getState();
    const item = store.bySession.get(sessionId)?.turnIndexItems.find(candidate => candidate.turnId === turnId);
    let anchorMessageId = item?.anchorMessageId
      ?? messagesRef.current.find(message => message.turnId === turnId)?.id;
    if (!anchorMessageId) {
      // 不把“索引尚未翻到该轮”当成不存在; 单独查询该轮, 再打开有界消息窗口.
      const page = await sessionsApi.listTurnMessages(sessionId, turnId);
      anchorMessageId = page.messages.find(message => message.kind === 'normal')?.id;
    }
    if (!isCurrentRequest()) return;
    if (!anchorMessageId) throw new Error('该轮暂时没有可定位的消息');
    if (messagesRef.current.some(message => message.id === anchorMessageId)) {
      store.cancelPendingWindowReplace(sessionId);
      viewport.scrollToMessage(anchorMessageId);
    } else await store.openAround(sessionId, anchorMessageId);
  }

  useEffect(() => {
    if (!navigationRequest || navigationRequest.sessionId !== sessionId || !scroller) return;
    // 换历史窗口会重新挂载视口, 同一个定位请求不能因此再查一次该轮.
    if (handledNavigationRequest.current === navigationRequest) return;
    handledNavigationRequest.current = navigationRequest;
    const request = navigationRequest;
    const stillRequested = (): boolean => {
      const navigation = useMainNavigationStore.getState();
      return navigation.turnNavigationRequest === request
        && navigation.activeView === MainView.Chat
        && navigation.viewedSessionId === sessionId;
    };
    void selectTurn(request.turnId, stillRequested)
      .then(() => {
        const located = useSessionHistoryStore.getState().bySession.get(sessionId);
        if (stillRequested() && located?.messages.some(message => message.turnId === request.turnId)) {
          onPlaybackTurnLocated(request.turnId);
        }
      })
      .catch(error => {
        if (stillRequested()) showToast(error instanceof Error ? error.message : '无法定位正在播放的回复', { variant: 'warning' });
      })
      .finally(() => useMainNavigationStore.getState().finishTurnNavigation(request));
  }, [navigationRequest, sessionId, scroller, onPlaybackTurnLocated]);

  async function returnToLatest(): Promise<void> {
    const store = useSessionHistoryStore.getState();
    store.cancelPendingWindowReplace(sessionId);
    if (!history.newerCursor && !history.loading) {
      viewport.scrollToLatest(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } else await store.loadLatest(sessionId, true);
  }

  const empty = messages.length === 0;
  const loadingEmpty = empty && (!history.loaded || Boolean(history.olderCursor || history.newerCursor));
  const showReturnToLatest = latestButtonBottom !== null && (!isAtBottom || Boolean(history.newerCursor));
  const showLocatePlayback = latestButtonBottom !== null && Boolean(playbackKey);
  const pairedNavigation = showReturnToLatest && showLocatePlayback;
  return (
    <div className="relative min-h-0 flex-1">
      <TurnNavigationRail sessionId={sessionId} visibleTurnIds={visibleTurnIds} onSelectTurn={selectTurn} />
      <div
        ref={setScroller}
        className="ema-chat-history-scroller absolute inset-0 overflow-x-hidden overflow-y-auto"
        tabIndex={0}
        aria-label="会话消息"
        onScroll={() => {
          if (!scroller) return;
          if (scroller.scrollTop !== lastScrollTop.current) {
            scrollDirection.current = scroller.scrollTop < lastScrollTop.current ? 'older' : 'newer';
          }
          lastScrollTop.current = scroller.scrollTop;
          checkPagination();
        }}
      >
        <div style={{ height: totalHeight, position: 'relative', width: '100%' }}>
          {virtualRows.map(row => {
            const message = messages[row.index]!;
            const turnId = message.turnId;
            const turn = turnId ? turns.get(turnId) : undefined;
            const endsTurn = Boolean(turnId && messages[row.index + 1]?.turnId !== turnId);
            let expanded = expansionByMessage.current.get(message.id);
            if (!expanded) {
              expanded = new Map();
              expansionByMessage.current.set(message.id, expanded);
            }
            return (
              <div key={row.key} ref={virtualizer.measureElement} data-index={row.index}
                className="ema-chat-history-content-inset"
                style={{ position: 'absolute', top: row.start, width: '100%' }}>
                <div className="ema-chat-content-column ema-chat-message-row"
                  data-message-id={message.id} data-turn-id={turnId ?? undefined}
                  data-playback-target={turnId !== null && turnId === locatedPlaybackTurnId || undefined}
                  onAnimationEnd={event => {
                    if (event.target === event.currentTarget) {
                      event.currentTarget.classList.remove('ema-chat-message-enter');
                    }
                  }}>
                  <MessageExpansionContext.Provider value={expanded}>
                    {isPendingInput(message) ? (
                      <UserMessage message={message} sessionId={sessionId} pending />
                    ) : (
                      <UIMessage message={message} sessionId={sessionId} toolResults={toolResults} terminal={turn?.terminal ?? true} />
                    )}
                  </MessageExpansionContext.Provider>
                  {endsTurn && turnId && (
                    <TurnFooter sessionId={sessionId} turnId={turnId} messages={messagesByTurn.get(turnId) ?? []}
                      turnStats={history.turnStatsById.get(turnId)} canFork={!turn} />
                  )}
                </div>
              </div>
            );
          })}
          <div ref={statusRef} className="ema-chat-history-content-inset"
            style={{ position: 'absolute', top: totalHeight - bottomInset - statusHeight, width: '100%' }}>
            <div className="ema-chat-content-column">
              <MessageListStatus error={history.error} newerError={history.newerError}
                loadingNewer={history.loadingNewer} activeCompact={activeCompact}
                onRetryNewer={() => void useSessionHistoryStore.getState().loadNewer(sessionId)}
                onRetryWindow={() => {
                  const store = useSessionHistoryStore.getState();
                  if (history.windowAnchorMessageId) void store.openAround(sessionId, history.windowAnchorMessageId);
                  else void store.loadLatest(sessionId, true);
                }} />
            </div>
          </div>
        </div>
      </div>
      {(history.loadingOlder || history.olderError || (history.loading && !empty)) && (
        <div className="ema-chat-history-load-status ema-chat-history-content-inset" role="status">
          <span className="truncate">{history.olderError ?? (history.loadingOlder ? '正在读取更早消息…' : '正在读取消息…')}</span>
          {history.olderError && <button type="button"
            onClick={() => void useSessionHistoryStore.getState().loadOlder(sessionId)}>重试</button>}
        </div>
      )}
      {empty && !history.error && !history.olderError && !history.newerError && !activeCompact && (
        <div className="absolute inset-0 flex flex-col" style={{ paddingBottom: bottomInset }}>
          {loadingEmpty
            ? <div className="flex flex-1 items-center justify-center text-sm text-[var(--ema-text-tertiary)]">正在读取消息…</div>
            : <ChatEmptyState sessionId={sessionId} />}
        </div>
      )}
      <Tooltip content="回到最新消息">
        <IconButton
          label="回到最新消息"
          icon="i-lucide:arrow-down"
          variant="ghost"
          size="sm"
          className="ema-chat-jump-latest"
          data-visible={showReturnToLatest}
          data-paired={pairedNavigation || undefined}
          aria-hidden={!showReturnToLatest}
          tabIndex={showReturnToLatest ? 0 : -1}
          disabled={!showReturnToLatest}
          style={{ bottom: latestButtonBottom ?? 0 }}
          onClick={() => void returnToLatest()}
        />
      </Tooltip>
      <Tooltip content="定位正在播放的回复 (不改变播放)">
        <IconButton
          label="定位正在播放的回复"
          icon="i-lucide:volume-2"
          variant="ghost"
          size="sm"
          className="ema-chat-jump-latest ema-chat-jump-speech"
          data-visible={showLocatePlayback}
          data-paired={pairedNavigation || undefined}
          aria-hidden={!showLocatePlayback}
          tabIndex={showLocatePlayback ? 0 : -1}
          disabled={!showLocatePlayback}
          style={{ bottom: latestButtonBottom ?? 0 }}
          onClick={() => {
            const playback = usePlaybackStore.getState();
            const key = playback.queue[0];
            if (playback.playbackStatus && key) {
              useMainNavigationStore.getState().viewTurn(key.sessionId, key.turnId);
            }
          }}
        />
      </Tooltip>
    </div>
  );
}

function MessageListStatus({
  loadingNewer, error, newerError, activeCompact, onRetryNewer, onRetryWindow,
}: {
  readonly loadingNewer: boolean;
  readonly error?: string;
  readonly newerError?: string;
  readonly activeCompact: ActiveCompact | null;
  readonly onRetryNewer: () => void;
  readonly onRetryWindow: () => void;
}): JSX.Element {
  const [compactElapsedSeconds, setCompactElapsedSeconds] = useState<number | null>(null);
  useEffect(() => {
    const startedAt = activeCompact?.startedAt;
    if (startedAt === null || startedAt === undefined) {
      setCompactElapsedSeconds(null);
      return;
    }
    const updateElapsed = (): void => setCompactElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
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
          <div role="status" className="ema-shimmer flex items-center gap-2 px-3 py-2 text-xs text-[var(--ema-text-secondary)]">
            <span className="i-ema:context-compact size-3.5 shrink-0 text-[var(--ema-primary)]" aria-hidden />
            <span>正在压缩上下文…</span>
          </div>
        </div>
      )}
      {loadingNewer && <div className="text-xs text-[var(--ema-text-tertiary)]">正在读取更新消息…</div>}
      {newerError && (
        <div className="flex items-center gap-2 text-xs text-[var(--ema-danger)]">
          <span>{newerError}</span><button type="button" onClick={onRetryNewer}>重试</button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-[var(--ema-danger)]">
          <span>{error}</span><button type="button" onClick={onRetryWindow}>重新读取</button>
        </div>
      )}
    </div>
  );
}

function ChatEmptyState({ sessionId }: { readonly sessionId: string }): JSX.Element {
  return <ConversationStarters onChoose={prompt => {
    const drafts = useChatDraftStore.getState();
    const draft = drafts.bySession.get(sessionId) ?? emptyChatDraft();
    drafts.setForSession(sessionId, { ...draft, text: prompt });
  }} />;
}
