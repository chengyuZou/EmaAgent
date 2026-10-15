// 渲染一轮最后一条可见消息之后的错误、编辑汇总、操作和统计.

import { useEffect, useMemo, useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import type { AssistantBlock, LlmTokenUsage } from '@ema-agent/llm';
import type { SessionMessage } from '@ema-agent/session';
import { estimateTextTokens } from '@ema-agent/token';
import type { SessionMessagePage } from '../../api/sessions.js';
import { showToast } from '../../lib/notifications/toast.js';
import { useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionStore } from '../../stores/session.js';
import {
  assistantOutputBlocks,
  isStreamingMessage,
  useTurnStore,
  type StreamingMessage,
  type TurnState,
} from '../../stores/turn.js';
import { TurnSpeechControls } from './turnSpeechControls.js';
import { TurnError } from './turnError.js';
import { historyAssistantSections } from './assistantSections.js';
import { toolResultsForMessages } from './UIMessage.js';
import { EditedFilesCard } from './toolBlocks/EditedFilesCard.js';
import { editedFiles, formatTurnTime, type ToolDisplayCall } from './toolBlocks/toolGroups.js';

export type SessionTurnStats = SessionMessagePage['turnStats'][number];

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
  const usage = useTurnStore(state => state.usageByTurn[turnId]);
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
  const streamingCalls = useMemo<ToolDisplayCall[]>(() => messages.flatMap(message => (
    isStreamingMessage(message)
      ? message.blocks.flatMap(block => block.type === 'tool_use'
        ? [{ source: 'streaming' as const, item: block }]
        : [])
      : []
  )), [messages]);
  const edited = useMemo(
    () => editedFiles([...persistedCalls, ...streamingCalls]),
    [streamingCalls, persistedCalls],
  );
  const textContent = useMemo(() => assistantText(messages), [messages]);
  const createdAt = messages.at(-1)?.createdAt ?? Date.now();
  const [copied, setCopied] = useState(false);
  const turnResult = turn ?? (turnStats?.status === 'failed' ? turnStats : undefined);

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

  const audioControls = (
    <TurnSpeechControls
      sessionId={sessionId}
      turnId={turnId}
    />
  );

  return (
    <>
      <TurnError
        errorCode={turnResult?.errorCode ?? null}
        errorMessage={turnResult?.errorMessage ?? null}
      />
      {edited.files.length > 0 && (
        <div className="ema-message-shell ema-turn-edited-files flex">
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
        <RunningTurnFooter
          turn={turn}
          usage={usage}
          elapsed={elapsed}
          audioControls={audioControls}
        />
      ) : (
        <HistoryTurnFooter
          turnId={turnId}
          createdAt={createdAt}
          textContent={textContent}
          turnStats={turnStats}
          canFork={canFork}
          audioControls={audioControls}
          copied={copied}
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
  audioControls,
}: {
  readonly turn: TurnState;
  readonly usage?: LlmTokenUsage;
  readonly elapsed: number;
  readonly audioControls: JSX.Element;
}): JSX.Element {
  const text = assistantOutputBlocks(turn)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('');
  const estimated = (usage?.outputTokens ?? 0) === 0;
  const outputTokens = estimated ? estimateTextTokens(text) : usage?.outputTokens ?? 0;

  return (
    <div className="ema-message-footer">
      <div className="ema-message-footer-actions">
        {audioControls}
      </div>
      <span className="ema-message-footer-stats">
        <span className={turn.terminal
          ? 'h-1 w-1 shrink-0 rounded-md bg-[var(--ema-text-tertiary)]'
          : 'h-1 w-1 shrink-0 animate-pulse rounded-md bg-[var(--ema-primary)]'} />
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
  audioControls,
  copied,
  onCopy,
}: {
  readonly turnId: string;
  readonly createdAt: number;
  readonly textContent: string;
  readonly turnStats?: SessionTurnStats;
  readonly canFork: boolean;
  readonly audioControls: JSX.Element;
  readonly copied: boolean;
  readonly onCopy: () => void;
}): JSX.Element {
  return (
    <div className="ema-message-footer">
      <div className="ema-message-footer-actions">
        {textContent && (
          <IconButton
            size="sm"
            variant="ghost"
            shape="rounded"
            label="复制"
            icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
            className="ema-chat-icon-btn chat-message-action"
            onClick={onCopy}
          />
        )}
        {audioControls}
        {canFork && <ForkButton turnId={turnId} />}
      </div>
      <span className="ema-message-footer-stats tabular-nums">
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
  const sessionId = useMainNavigationStore(state => state.viewedSessionId);
  if (!sessionId) return null;
  return (
    <IconButton
      size="sm"
      variant="ghost"
      shape="rounded"
      iconNode={<span className="i-lucide:split rotate-90" />}
      label="从该回复创建新会话"
      className="ema-chat-icon-btn chat-message-action"
      onClick={() => void useSessionStore.getState().forkSession(sessionId, turnId)
        .then(newSessionId => {
          useMainNavigationStore.getState().viewSession(newSessionId);
          showToast('已从该回复创建新会话');
        })
        .catch(error => showToast(
          error instanceof Error ? error.message : '创建新会话失败',
          { variant: 'danger' },
        ))}
    />
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
