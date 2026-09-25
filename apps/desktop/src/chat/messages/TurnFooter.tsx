// 渲染一轮最后一条可见消息之后的编辑汇总、操作和统计.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import type { AssistantBlock, LlmTokenUsage } from '@ema-agent/llm';
import type { SessionMessage } from '@ema-agent/session';
import { estimateTextTokens } from '@ema-agent/token';
import type { SessionMessagePage } from '../../api/sessions.js';
import { showToast } from '../../lib/toast.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { useSessionStore } from '../../stores/session.js';
import {
  assistantOutputBlocks,
  isStreamingMessage,
  sumTurnUsage,
  useTurnStore,
  type StreamingMessage,
  type TurnState,
} from '../../stores/turn.js';
import { replayTurn, stopTurnPlayback, usePlaybackStore } from '../speech/turnSpeechPlayback.js';
import { historyAssistantSections } from './assistantSections.js';
import { toolResultsForMessages } from './UIMessage.js';
import { EditedFilesCard } from './toolBlocks/EditedFilesCard.js';
import { editedFiles, formatTurnTime, type ToolDisplayCall } from './toolBlocks/toolGroups.js';

export type SessionTurnStats = SessionMessagePage['turnStats'][number];

const AUDIO_CLICK_THROTTLE_MS = 600;

export function TurnFooter({
  sessionId,
  turnId,
  messages,
  turnStats,
  canFork,
}: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: readonly (SessionMessage | StreamingMessage)[];
  readonly turnStats?: SessionTurnStats;
  readonly canFork: boolean;
}): JSX.Element {
  const turn = useTurnStore(state => state.turnsBySession.get(sessionId)?.get(turnId));
  const usage = useTurnStore(state => sumTurnUsage(state, turnId));
  const [elapsed, setElapsed] = useState(() => (
    turn ? Math.round((Date.now() - turn.startedAt) / 1000) : 0
  ));
  const toolResults = useMemo(() => toolResultsForMessages(messages), [messages]);
  const persistedCalls = useMemo(() => {
    const assistantMessages = messages.filter((message): message is SessionMessage => (
      !isStreamingMessage(message) && message.role === 'assistant'
    ));
    return historyAssistantSections(assistantMessages, toolResults)
      .flatMap(section => section.kind === 'block' ? [] : section.calls);
  }, [messages, toolResults]);
  const liveCalls = useMemo<ToolDisplayCall[]>(() => messages.flatMap(message => (
    isStreamingMessage(message)
      ? message.blocks.flatMap(block => block.type === 'tool_use'
        ? [{ source: 'live' as const, item: block }]
        : [])
      : []
  )), [messages]);
  const edited = useMemo(
    () => editedFiles([...persistedCalls, ...liveCalls]),
    [liveCalls, persistedCalls],
  );
  const textContent = useMemo(() => assistantText(messages), [messages]);
  const createdAt = messages.at(-1)?.createdAt ?? Date.now();
  const isPlaying = usePlaybackStore(state => state.playingTurnId === turnId);
  const lastAudioClick = useRef(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!turn) return;
    const updateElapsed = (): void => {
      setElapsed(Math.round((Date.now() - turn.startedAt) / 1000));
    };
    updateElapsed();
    if (turn.terminal) return;
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [turn?.startedAt, turn?.terminal]);

  const toggleAudio = (): void => {
    const now = Date.now();
    if (now - lastAudioClick.current < AUDIO_CLICK_THROTTLE_MS) return;
    lastAudioClick.current = now;
    if (isPlaying) {
      stopTurnPlayback(turnId);
      return;
    }
    void replayTurn(turnId).catch(() => {
      showToast('该轮没有可重播的语音', { variant: 'warning' });
    });
  };

  return (
    <>
      {edited.files.length > 0 && (
        <div className="ema-message-shell flex mr-12">
          <div className="flex min-w-20 w-full max-w-full flex-col">
            <EditedFilesCard
              files={edited.files}
              additions={edited.additions}
              deletions={edited.deletions}
            />
          </div>
        </div>
      )}
      {turn ? (
        <RunningTurnFooter turn={turn} usage={usage} elapsed={elapsed} />
      ) : (
        <HistoryTurnFooter
          turnId={turnId}
          createdAt={createdAt}
          textContent={textContent}
          turnStats={turnStats}
          canFork={canFork}
          isPlaying={isPlaying}
          copied={copied}
          onToggleAudio={toggleAudio}
          onCopy={() => void navigator.clipboard.writeText(textContent).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          })}
        />
      )}
    </>
  );
}

function RunningTurnFooter({
  turn,
  usage,
  elapsed,
}: {
  readonly turn: TurnState;
  readonly usage?: LlmTokenUsage;
  readonly elapsed: number;
}): JSX.Element {
  const text = assistantOutputBlocks(turn)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('');
  const estimated = (usage?.outputTokens ?? 0) === 0;
  const outputTokens = estimated ? estimateTextTokens(text) : usage?.outputTokens ?? 0;

  return (
    <div className="mr-12 mt-1.5 flex min-h-6 items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
      <ModeLabel sessionMode={turn.sessionMode} narrativePolicy={turn.narrativePolicy} />
      <span className="flex items-center gap-1.5">
        <span className={turn.terminal
          ? 'h-1 w-1 shrink-0 rounded-full bg-[var(--ema-text-tertiary)]'
          : 'h-1 w-1 shrink-0 animate-pulse rounded-full bg-[var(--ema-primary)]'} />
        <span className="tabular-nums">{elapsed}s</span>
        {(usage?.inputTokens ?? 0) + outputTokens > 0 && (
          <span className="tabular-nums">
            {estimated ? '≈ ' : ''}Token: {formatTokens((usage?.inputTokens ?? 0) + outputTokens)}
          </span>
        )}
        {turn.thinkingActive && <span>· Thinking</span>}
      </span>
    </div>
  );
}

function HistoryTurnFooter({
  turnId,
  createdAt,
  textContent,
  turnStats,
  canFork,
  isPlaying,
  copied,
  onToggleAudio,
  onCopy,
}: {
  readonly turnId: string;
  readonly createdAt: number;
  readonly textContent: string;
  readonly turnStats?: SessionTurnStats;
  readonly canFork: boolean;
  readonly isPlaying: boolean;
  readonly copied: boolean;
  readonly onToggleAudio: () => void;
  readonly onCopy: () => void;
}): JSX.Element {
  const showAudio = isPlaying || turnStats?.audioAvailable === true;
  return (
    <div className="mr-12 mt-1.5 flex min-h-6 items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
      {showAudio && (
        <IconButton
          size="sm"
          label={isPlaying ? '停止播放' : '重播语音'}
          icon={isPlaying ? 'i-lucide:square' : 'i-lucide:audio-lines'}
          className="ema-chat-icon-btn chat-message-action -ml-0.5"
          onClick={onToggleAudio}
        />
      )}
      {textContent && (
        <IconButton
          size="sm"
          label="复制"
          icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
          className="ema-chat-icon-btn chat-message-action"
          onClick={onCopy}
        />
      )}
      {canFork && <ForkButton turnId={turnId} />}
      <span className="ml-auto flex items-center gap-2 opacity-60 tabular-nums">
        <span>{formatTurnTime(createdAt)}</span>
        {turnStats?.inputTokens !== undefined && (
          <span>Token: {formatTokens(turnStats.inputTokens + turnStats.outputTokens)}</span>
        )}
        {turnStats?.durationMs !== null && turnStats?.durationMs !== undefined && (
          <span>{(turnStats.durationMs / 1000).toFixed(1)}s</span>
        )}
      </span>
    </div>
  );
}

function ForkButton({ turnId }: { readonly turnId: string }): JSX.Element | null {
  const sessionId = useChatNavigationStore(state => state.viewedSessionId);
  if (!sessionId) return null;
  return (
    <IconButton
      size="sm"
      icon="i-lucide:git-fork"
      label="从该回复创建新会话"
      className="ema-chat-icon-btn chat-message-action"
      onClick={() => void useSessionStore.getState().forkSession(sessionId, turnId)
        .then(newSessionId => {
          useChatNavigationStore.getState().viewSession(newSessionId);
          showToast('已从该回复创建新会话');
        })
        .catch(error => showToast(
          error instanceof Error ? error.message : '创建新会话失败',
          { variant: 'danger' },
        ))}
    />
  );
}

function ModeLabel({
  sessionMode,
  narrativePolicy,
}: {
  readonly sessionMode: string;
  readonly narrativePolicy: string;
}): JSX.Element {
  const color = sessionMode === 'work'
    ? 'text-[var(--ema-text-secondary)]'
    : 'text-[var(--ema-text-tertiary)]';
  return (
    <span className={`ema-message-mode px-1.5 py-0.5 font-medium ${color}`}>
      {sessionMode === 'work' ? 'Work' : 'Chat'}
      {narrativePolicy === 'always' ? ' · 剧情常开' : ''}
    </span>
  );
}

function assistantText(messages: readonly (SessionMessage | StreamingMessage)[]): string {
  return messages.flatMap(message => {
    if (isStreamingMessage(message)) {
      return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []);
    }
    if (message.role !== 'assistant' || !Array.isArray(message.blocks)) return [];
    return (message.blocks as AssistantBlock[])
      .flatMap(block => block.type === 'text' ? [block.text] : []);
  }).join('');
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
