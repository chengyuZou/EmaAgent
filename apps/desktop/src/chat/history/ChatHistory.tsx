// 展示当前 Session 的热尾或旧历史窗口：Turn 分组渲染 + 流式气泡 + 待发送气泡 + 压缩分界行。
import { useRef, useEffect, useMemo, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';

import { useCurrentSession } from '../state/currentSession.js';
import { useMessages } from '../state/messages.js';
import { useChatHistoryScroll } from './useChatHistoryScroll.js';
import { UserBubble, PendingBubble } from '../messages/UserBubble.js';
import { AssistantBubble, StreamingAssistantBubble } from '../messages/AssistantBubble.js';
import { Markdown } from '../../markdown/renderer.js';
import {
  EMPTY_SESSION_HISTORY,
  useSessionHistory,
} from './sessionHistory.js';
import {
  groupMessagesByTurn,
  messageText,
  toolResultIndex,
  type TurnMessageGroup,
} from './turnGroups.js';
import { ChatEmptyState } from './ChatEmptyState.js';
import { TurnRail } from './TurnRail.js';
import type { SessionHistoryMessage } from '../../api/sessions.js';

const EMPTY_MESSAGES: SessionHistoryMessage[] = [];

export function ChatHistory(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const viewedId = useCurrentSession((s) => s.viewedSessionId);
  const messages = useMessages((s) =>
    viewedId ? (s.messages.get(viewedId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const turns = useMessages((s) =>
    viewedId ? s.turns.get(viewedId) : undefined,
  );
  const stream = useMessages((s) =>
    viewedId ? s.streamBySession.get(viewedId) ?? null : null,
  );
  const pending = useMessages((s) =>
    viewedId ? s.pendingInputBySession.get(viewedId) ?? null : null,
  );
  const stopReason = useMessages((s) =>
    viewedId ? s.stopReasonBySession.get(viewedId) ?? null : null,
  );
  const loadedSessions = useMessages((s) => s.loadedSessions);
  const sessionHistory = useSessionHistory((state) =>
    viewedId
      ? state.bySession.get(viewedId) ?? EMPTY_SESSION_HISTORY
      : EMPTY_SESSION_HISTORY,
  );
  const archiveWindow = useMemo(
    () => sessionHistory.archiveWindows.find(
      (window) => window.anchorTurnId === sessionHistory.activeArchiveTurnId,
    ),
    [sessionHistory.activeArchiveTurnId, sessionHistory.archiveWindows],
  );

  const displayedMessages = sessionHistory.mode === 'archive' && archiveWindow
    ? archiveWindow.result.messages
    : messages;
  const displayedTurns = sessionHistory.mode === 'archive' && archiveWindow
    ? archiveWindow.result.turns
    : turns ?? [];
  const displayedStream = sessionHistory.mode === 'tail' ? stream : null;
  const displayedPending = sessionHistory.mode === 'tail' ? pending : null;

  const groups = useMemo(
    () => groupMessagesByTurn(displayedMessages, displayedTurns),
    [displayedMessages, displayedTurns],
  );
  const toolResults = useMemo(
    () => toolResultIndex(displayedMessages),
    [displayedMessages],
  );

  useEffect(() => {
    if (!viewedId || loadedSessions.has(viewedId)) return;
    void useMessages.getState().loadMessages(viewedId);
  }, [viewedId, loadedSessions]);

  const scrollToTurnId = useCurrentSession((s) => s.scrollToTurnId);
  useEffect(() => {
    if (!scrollToTurnId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`#turn-${CSS.escape(scrollToTurnId)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    useCurrentSession.setState({ scrollToTurnId: null });
  }, [groups, scrollToTurnId]);

  const { userScrolled, resetUserScrolled } = useChatHistoryScroll(
    containerRef,
    [groups, displayedStream],
    [viewedId],
  );

  const lastUserGroupKey = (() => {
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (group && group.messages.length === 1 && group.messages[0]?.role === 'user') {
        return groupKey(group, i);
      }
    }
    return null;
  })();

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !viewedId) return;
    const visibility = new Map<Element, IntersectionObserverEntry>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visibility.set(entry.target, entry);
      const visible = [...visibility.values()]
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => (
          Math.abs(left.boundingClientRect.top - root.getBoundingClientRect().top)
          - Math.abs(right.boundingClientRect.top - root.getBoundingClientRect().top)
        ))[0];
      const turnId = visible?.target.getAttribute('data-turn-id');
      if (turnId) {
        useSessionHistory.getState().setCurrentTurn(viewedId, turnId);
      }
    }, { root, threshold: 0.15 });
    const targets = root.querySelectorAll('[data-turn-id]');
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [groups, displayedStream, viewedId]);

  async function selectTurn(turnId: string): Promise<void> {
    if (!viewedId) return;
    const inTail = groups.some((group) => group.turnId === turnId);
    if (inTail) {
      useSessionHistory.getState().showTail(viewedId);
      requestAnimationFrame(() => {
        useCurrentSession.getState().scrollToTurn(turnId);
      });
      return;
    }
    await useSessionHistory.getState().openArchive(viewedId, turnId);
    const latest = useSessionHistory.getState().bySession.get(viewedId);
    if (latest?.mode === 'archive' && latest.activeArchiveTurnId === turnId) {
      requestAnimationFrame(() => {
        useCurrentSession.getState().scrollToTurn(turnId);
      });
    }
  }

  function returnToTail(): void {
    if (!viewedId) return;
    useSessionHistory.getState().showTail(viewedId);
    requestAnimationFrame(resetUserScrolled);
  }

  if (!viewedId) {
    return <ChatEmptyState />;
  }

  return (
    <div className="flex-1 relative ema-fade-mask-top">
      <TurnRail sessionId={viewedId} onSelectTurn={selectTurn} />
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto py-4 pl-14 pr-4">
        {groups.length === 0 && !displayedStream && !displayedPending && (
          <div className="flex h-full">
            <ChatEmptyState sessionId={viewedId} />
          </div>
        )}

        <div className="flex flex-col gap-2 max-w-2xl mx-auto">
          {groups.map((group, index) => {
            const key = groupKey(group, index);
            const single = group.messages.length === 1 ? group.messages[0] : undefined;
            const isUserGroup = group.messages.every((m) => m.role === 'user');
            const canEdit = sessionHistory.mode === 'tail'
              && isUserGroup
              && key === lastUserGroupKey
              && !stream;
            const canFork = sessionHistory.mode === 'tail'
              && !isUserGroup
              && group.turnId !== null
              && group.turn?.completedAt != null;
            return (
              <div
                key={key}
                id={group.turnId ? `turn-${group.turnId}` : undefined}
                {...(group.turnId ? { 'data-turn-id': group.turnId } : {})}
              >
                <GroupRouter
                  group={group}
                  single={single}
                  toolResults={toolResults}
                  canEditUser={canEdit}
                  canForkAssistant={canFork}
                />
              </div>
            );
          })}

          {displayedPending && <PendingBubble pending={displayedPending} />}

          {displayedStream && (
            <div data-turn-id={displayedStream.turnId} id={`turn-${displayedStream.turnId}`}>
              <StreamingAssistantBubble stream={displayedStream} />
            </div>
          )}

          {sessionHistory.mode === 'tail' && stopReason && !stream && (
            <div className="flex justify-center">
              <div className="ema-slide-up rounded-full px-4 py-1.5 text-xs bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]"
                   style={{ border: '1px solid var(--ema-border)' }}>
                {stopReason}
              </div>
            </div>
          )}
        </div>
      </div>

      {sessionHistory.archiveLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--ema-mask)] text-xs text-[var(--ema-text-tertiary)]">
          正在读取历史窗口…
        </div>
      )}

      {sessionHistory.mode === 'archive' && (
        <Button
          variant="ghost"
          className="ema-slide-up absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-1.5 text-xs text-[var(--ema-text-secondary)] shadow-lg hover:bg-[var(--ema-surface-3)]"
          onClick={returnToTail}
        >
          <span className="i-lucide:arrow-down mr-1 text-xs align-middle" aria-hidden />
          {sessionHistory.unseenTailCount > 0
            ? `${sessionHistory.unseenTailCount} 条新回复 · 回到最新`
            : '回到最新'}
        </Button>
      )}

      {sessionHistory.mode === 'tail' && userScrolled && (
        <Button
          variant="ghost"
          className="ema-slide-up absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs transition-colors shadow-lg bg-[var(--ema-surface-2)] hover:bg-[var(--ema-surface-3)] border border-[var(--ema-border)] text-[var(--ema-text-secondary)]"
          onClick={resetUserScrolled}
        >
          <span className="i-lucide:arrow-down text-xs mr-1 align-middle" aria-hidden />回到底部
        </Button>
      )}
    </div>
  );
}

// ── Internal ──────────────────────────────────────────────────────────────────

function groupKey(group: TurnMessageGroup, index: number): string {
  const first = group.messages[0];
  return first?.id ?? `${group.turnId ?? 'nogroup'}:${index}`;
}

function GroupRouter({
  group,
  single,
  toolResults,
  canEditUser,
  canForkAssistant,
}: {
  group: TurnMessageGroup;
  single: SessionHistoryMessage | undefined;
  toolResults: ReadonlyMap<string, import('@ema-agent/session').ToolResultBlock>;
  canEditUser: boolean;
  canForkAssistant: boolean;
}): JSX.Element | null {
  // kind 优先：summary 消息渲染为压缩分界行，不是用户气泡。
  if (single?.kind === 'summary') {
    return <CompactDivider message={single} />;
  }
  if (single?.role === 'user') {
    return <UserBubble message={single} canEdit={canEditUser} />;
  }
  if (group.messages.some((m) => m.role === 'assistant')) {
    return <AssistantBubble group={group} toolResults={toolResults} canFork={canForkAssistant} />;
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
      <span className="text-xs whitespace-nowrap text-[var(--ema-text-tertiary)]">{text}</span>
      <div className="flex-1 border-t border-[var(--ema-border)]" />
    </div>
  );
}

/** 压缩分界行：折叠时一行计数摘要，展开显示摘要正文。 */
function CompactDivider({ message }: { message: SessionHistoryMessage }): JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = messageText(message);
  return (
    <div className="flex flex-col">
      <button
        className="flex items-center gap-1.5 py-1 text-left text-xs select-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)] transition-colors"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="i-lucide:settings-2 text-[11px]" aria-hidden />
        <span className={`i-lucide:chevron-right text-[10px] transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span>压缩上下文</span>
      </button>
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="pt-1 pl-5 text-xs text-[var(--ema-text-tertiary)]">
          <Markdown source={summary} />
        </div>
      </div>
    </div>
  );
}
