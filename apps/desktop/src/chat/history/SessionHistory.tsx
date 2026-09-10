// 用虚拟列表渲染持久 Message 窗口, 并把当前 LiveTurn 作为独立尾项展示.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ToolResult } from '@ema-agent/tools';
import { Markdown } from '../../markdown/renderer.js';
import type { SessionHistoryMessage } from '../../api/sessions.js';
import { charactersApi } from '../../api/characters.js';
import { fetchServerObjectUrl } from '../../lib/serverFileUrl.js';
import { useCharacterStore } from '../../stores/character.js';
import { useSessionStore } from '../../stores/session.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { useHistoryStore, EMPTY_SESSION_HISTORY } from '../state/history.js';
import { useLiveTurns, type LiveTurn } from '../state/liveTurns.js';
import { UserMessage } from '../messages/UserMessage.js';
import { AssistantMessage, StreamingAssistantMessage } from '../messages/AssistantMessage.js';
import { TurnNavigationRail } from './TurnNavigationRail.js';
import {
  groupMessagesByTurn,
  messageText,
  toolResultIndex,
  type TurnMessageGroup,
} from '../messages/MessageBlocks.js';

type HistoryRow =
  | { readonly type: 'message_group'; readonly group: TurnMessageGroup }
  | { readonly type: 'live_turn'; readonly stream: LiveTurn }
  | { readonly type: 'stop_reason'; readonly reason: string };

export function SessionHistory({ sessionId }: { sessionId: string }): JSX.Element {
  const listRef = useRef<VirtuosoHandle | null>(null);
  const previousGroupKeys = useRef<readonly string[]>([]);
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const history = useHistoryStore((state) => (
    state.bySession.get(sessionId) ?? EMPTY_SESSION_HISTORY
  ));
  const stream = useLiveTurns((state) => state.bySession.get(sessionId));
  const stopReason = useLiveTurns((state) => state.stopReasonBySession.get(sessionId));

  useEffect(() => {
    void useHistoryStore.getState().loadLatest(sessionId);
  }, [sessionId]);

  const groups = useMemo(
    () => groupMessagesByTurn(history?.messages ?? []),
    [history?.messages],
  );
  const results = useMemo(
    () => toolResultIndex(history?.messages ?? []),
    [history?.messages],
  );
  const rows = useMemo<HistoryRow[]>(() => [
    ...groups.map(group => ({ type: 'message_group' as const, group })),
    ...(stream ? [{ type: 'live_turn' as const, stream }] : []),
    ...(stopReason && !stream ? [{ type: 'stop_reason' as const, reason: stopReason }] : []),
  ], [groups, stopReason, stream]);

  const groupKeys = useMemo(
    () => groups.map((group, index) => (
      group.messages[0]?.id ?? `${group.turnId ?? 'message'}:${index}`
    )),
    [groups],
  );
  useLayoutEffect(() => {
    const previousFirst = previousGroupKeys.current[0];
    if (previousFirst) {
      const prepended = groupKeys.indexOf(previousFirst);
      if (prepended > 0) setFirstItemIndex(value => value - prepended);
    }
    previousGroupKeys.current = groupKeys;
  }, [groupKeys]);
  useEffect(() => {
    previousGroupKeys.current = [];
    setFirstItemIndex(1_000_000);
  }, [sessionId]);

  async function selectTurn(turnId: string): Promise<void> {
    const loadedIndex = groups.findIndex((group) => group.turnId === turnId);
    if (loadedIndex >= 0) {
      listRef.current?.scrollToIndex({
        index: firstItemIndex + loadedIndex,
        align: 'start',
        behavior: 'smooth',
      });
      return;
    }
    const item = history.turnIndexItems.find((candidate) => candidate.turnId === turnId);
    if (!item?.anchorMessageId) return;
    await useHistoryStore.getState().openAround(sessionId, item.anchorMessageId);
    requestAnimationFrame(() => {
      const messages = useHistoryStore.getState().bySession.get(sessionId)?.messages ?? [];
      const index = groupMessagesByTurn(messages)
        .findIndex((group) => group.turnId === turnId);
      if (index >= 0) {
        listRef.current?.scrollToIndex({
          index: firstItemIndex + index,
          align: 'start',
        });
      }
    });
  }

  if (!history.loaded && history.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--ema-text-tertiary)]">
        正在读取消息…
      </div>
    );
  }
  if (rows.length === 0) {
    return <ChatEmptyState sessionId={sessionId} />;
  }

  return (
    <div className="relative flex-1 min-h-0 ema-fade-mask-top">
      <TurnNavigationRail sessionId={sessionId} onSelectTurn={selectTurn} />
      <Virtuoso
        ref={listRef}
        className="absolute inset-0 pl-14 pr-4"
        data={rows}
        firstItemIndex={firstItemIndex}
        computeItemKey={(index, row) => {
          if (row.type === 'message_group') return row.group.messages[0]?.id ?? index;
          if (row.type === 'live_turn') return `live:${row.stream.turnId}`;
          return `stop:${row.reason}`;
        }}
        followOutput={stream ? 'smooth' : false}
        initialTopMostItemIndex={firstItemIndex + rows.length - 1}
        startReached={() => {
          if (history.hasOlder) {
            void useHistoryStore.getState().loadOlder(sessionId);
          }
        }}
        endReached={() => {
          if (history.hasNewer) {
            void useHistoryStore.getState().loadNewer(sessionId);
          }
        }}
        rangeChanged={(range) => {
          const row = rows[range.startIndex - firstItemIndex];
          if (row?.type === 'message_group' && row.group.turnId) {
            useHistoryStore.getState().setCurrentTurn(sessionId, row.group.turnId);
          }
        }}
        components={{
          Header: () => history?.loadingOlder ? (
            <div className="py-2 text-center text-xs text-[var(--ema-text-tertiary)]">
              正在读取更早消息…
            </div>
          ) : null,
          Footer: () => history?.loadingNewer ? (
            <div className="py-2 text-center text-xs text-[var(--ema-text-tertiary)]">
              正在读取更新消息…
            </div>
          ) : (
            <div className="h-4" />
          ),
        }}
        itemContent={(index, row) => (
          <div
            className="mx-auto max-w-2xl py-1.5"
            data-turn-id={
              row.type === 'message_group'
                ? row.group.turnId ?? undefined
                : row.type === 'live_turn'
                  ? row.stream.turnId
                  : undefined
            }
          >
            <HistoryRowRenderer
              row={row}
              results={results}
              canEdit={index === rows.length - 1 && !stream}
            />
          </div>
        )}
      />
      {/* TODO: WebSocket 增加有界 delta 重放后, 在这里显示断线缺口并请求重播. */}
    </div>
  );
}

function HistoryRowRenderer({
  row,
  results,
  canEdit,
}: {
  row: HistoryRow;
  results: ReadonlyMap<string, ToolResult>;
  canEdit: boolean;
}): JSX.Element | null {
  if (row.type === 'live_turn') {
    return <StreamingAssistantMessage stream={row.stream} />;
  }
  if (row.type === 'stop_reason') {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-[var(--ema-surface-2)] px-4 py-1.5 text-xs text-[var(--ema-text-tertiary)]">
          {row.reason}
        </span>
      </div>
    );
  }
  const group = row.group;
  const single = group.messages.length === 1 ? group.messages[0] : undefined;
  if (single?.kind === 'summary') {
    return <CompactDivider message={single} />;
  }
  if (single?.role === 'user') {
    return <UserMessage message={single} canEdit={canEdit} />;
  }
  if (group.messages.some((message) => message.role === 'assistant')) {
    return (
      <AssistantMessage
        group={group}
        toolResults={results}
        canFork={group.turnId !== null}
      />
    );
  }
  if (single?.role === 'system') {
    return <DividerRow text={messageText(single)} />;
  }
  return null;
}

function DividerRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-3 py-2">
      <div className="flex-1 border-t border-[var(--ema-border)]" />
      <span className="whitespace-nowrap text-xs text-[var(--ema-text-tertiary)]">
        {text}
      </span>
      <div className="flex-1 border-t border-[var(--ema-border)]" />
    </div>
  );
}

function CompactDivider({ message }: { message: SessionHistoryMessage }): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className="i-lucide:fold-horizontal" aria-hidden />
      <span>上下文已压缩</span>
      <span className="line-clamp-1 opacity-60">
        <Markdown source={messageText(message)} />
      </span>
    </div>
  );
}

function ChatEmptyState({ sessionId }: { sessionId: string }): JSX.Element {
  const characterName = useCharacterStore(state => state.activeName);
  const character = useCharacterStore((state) => (
    state.characters.find((item) => item.name === state.activeName)
  ));
  const workspaceRoot = useSessionStore((state) => (
    state.sessions.byId.get(sessionId)?.workspaceRoot ?? null
  ));
  const [illustrationUrl, setIllustrationUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!characterName) {
      setIllustrationUrl(null);
      return;
    }
    let mounted = true;
    let objectUrl: string | null = null;
    void charactersApi.presentation(characterName)
      .then(async (presentation) => {
        if (presentation.status !== 'illustration') return null;
        return fetchServerObjectUrl(charactersApi.illustrationFileUrl(
          characterName,
          presentation.resource.name,
        ));
      })
      .then((url) => {
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
  const workspaceName = workspaceRoot?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <div className="ema-empty-state">
      <div className="ema-empty-state-glow" aria-hidden />
      {illustrationUrl ? (
        <img
          className="ema-empty-state-avatar"
          src={illustrationUrl}
          alt={character?.name ?? '角色'}
          draggable={false}
        />
      ) : (
        <div className="ema-empty-state-avatar ema-empty-state-avatar-fallback" aria-hidden>
          <span className="i-lucide:paw-print" />
        </div>
      )}
      <h2 className="ema-empty-state-title">
        {character ? `和 ${character.name} 开始聊天` : '开始聊天吧'}
      </h2>
      {workspaceName && (
        <div className="ema-empty-state-chip">
          <span className="i-lucide:folder" aria-hidden />
          {workspaceName}
        </div>
      )}
    </div>
  );
}
