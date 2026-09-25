// 按单条可见 Message 虚拟化持久 History 与当前 Turn.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { SessionMessage } from '@ema-agent/session';
import { charactersApi } from '../../api/characters.js';
import { fetchServerObjectUrl } from '../../lib/serverFileUrl.js';
import { useCharacterStore } from '../../stores/character.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useSessionStore } from '../../stores/session.js';
import {
  isStreamingMessage,
  useTurnStore,
  type StreamingMessage,
  type TurnState,
} from '../../stores/turn.js';
import { scheduleTurnHistoryClosure } from '../session/turnHistoryClosure.js';
import { TurnNavigationRail } from '../history/TurnNavigationRail.js';
import { TurnFooter, type SessionTurnStats } from './TurnFooter.js';
import { UIMessage, toolResultsForMessages } from './UIMessage.js';

const INITIAL_ITEM_INDEX = 1_000_000;
const MESSAGE_TOP_INSET = 40;

type MessageListStyle = CSSProperties & {
  '--ema-message-top-inset': string;
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
}: {
  readonly sessionId: string;
}): JSX.Element {
  const listRef = useRef<VirtuosoHandle | null>(null);
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
  const windowId = `${sessionId}:${history.windowAnchorMessageId ?? ''}`;
  const previousItems = useRef<{ windowId: string; keys: readonly string[] }>({
    windowId,
    keys: [],
  });
  const [listIndex, setListIndex] = useState({ windowId, firstItemIndex: INITIAL_ITEM_INDEX });
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [visibleTurnIds, setVisibleTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const attachScroller = useCallback((element: HTMLElement | Window | null): void => {
    setScrollerElement(element instanceof HTMLElement ? element : null);
  }, []);
  const firstItemIndex = listIndex.windowId === windowId
    ? listIndex.firstItemIndex
    : INITIAL_ITEM_INDEX;
  const turns = useTurnStore(useShallow(state => (
    new Map(state.turnsBySession.get(sessionId) ?? [])
  )));
  const stopReason = useTurnStore(state => state.stopReasonBySession.get(sessionId));

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
  const itemKeys = useMemo(() => messages.map(messageListKey), [messages]);

  useLayoutEffect(() => {
    if (previousItems.current.windowId !== windowId) {
      previousItems.current = { windowId, keys: itemKeys };
      setListIndex({ windowId, firstItemIndex: INITIAL_ITEM_INDEX });
      return;
    }
    const previousFirst = previousItems.current.keys[0];
    if (previousFirst) {
      const prepended = itemKeys.indexOf(previousFirst);
      if (prepended > 0) {
        setListIndex(value => ({
          windowId,
          firstItemIndex: value.firstItemIndex - prepended,
        }));
      }
    }
    previousItems.current = { windowId, keys: itemKeys };
  }, [itemKeys, windowId]);

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
      useSessionHistoryStore.getState().cancelPendingWindowReplace(sessionId);
      listRef.current?.scrollToIndex(messageScrollLocation(loadedIndex));
      return;
    }

    await useSessionHistoryStore.getState().openAround(sessionId, item.anchorMessageId);
  }

  const anchorIndex = history.windowAnchorMessageId
    ? messages.findIndex(message => message.id === history.windowAnchorMessageId)
    : -1;

  if (!history.loaded && history.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--ema-text-tertiary)]">
        正在读取消息…
      </div>
    );
  }
  if (messages.length === 0) {
    if (!history.error && !stopReason) return <ChatEmptyState sessionId={sessionId} />;
    return (
      <div className="flex flex-1 items-end justify-center pb-4">
        <MessageListStatus
          loadingNewer={history.loadingNewer}
          error={history.error}
          stopReason={stopReason}
        />
      </div>
    );
  }

  return (
    <div
      className="relative flex-1 min-h-0 ema-fade-mask-top"
      style={{ '--ema-message-top-inset': `${MESSAGE_TOP_INSET}px` } as MessageListStyle}
    >
      <TurnNavigationRail
        sessionId={sessionId}
        visibleTurnIds={visibleTurnIds}
        onSelectTurn={selectTurn}
      />
      <Virtuoso
        key={windowId}
        ref={listRef}
        scrollerRef={attachScroller}
        className="absolute inset-0 pl-14 pr-4 overflow-x-hidden"
        data={messages}
        firstItemIndex={firstItemIndex}
        computeItemKey={(_index, message) => messageListKey(message)}
        followOutput={turns.size > 0 ? 'auto' : false}
        initialTopMostItemIndex={anchorIndex >= 0
          ? messageScrollLocation(anchorIndex)
          : messages.length - 1}
        startReached={() => {
          if (history.olderCursor) void useSessionHistoryStore.getState().loadOlder(sessionId);
        }}
        endReached={() => {
          if (history.newerCursor) void useSessionHistoryStore.getState().loadNewer(sessionId);
        }}
        components={{
          Header: () => (
            <>
              <div aria-hidden style={{ height: MESSAGE_TOP_INSET }} />
              {history.loadingOlder && (
                <div className="py-2 text-center text-xs text-[var(--ema-text-tertiary)]">
                  正在读取更早消息…
                </div>
              )}
            </>
          ),
          Footer: () => (
            <MessageListStatus
              loadingNewer={history.loadingNewer}
              error={history.error}
              stopReason={turns.size === 0 ? stopReason : undefined}
            />
          ),
        }}
        itemContent={(index, message) => {
          const turnId = message.turnId;
          const next = messages[index - firstItemIndex + 1];
          const endsTurn = Boolean(turnId && next?.turnId !== turnId);
          const turn = turnId ? turns.get(turnId) : undefined;
          return (
            <div
              className="mx-auto max-w-2xl py-1.5"
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
}: {
  readonly loadingNewer: boolean;
  readonly error?: string;
  readonly stopReason?: string;
}): JSX.Element {
  return (
    <div className="flex min-h-4 flex-col items-center gap-2 py-2">
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
