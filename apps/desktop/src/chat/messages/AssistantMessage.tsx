// 助手气泡：历史路径渲染 TurnMessageGroup（原始消息 + Turn 记录 + 结果索引），
// 流式路径渲染 LiveTurn（瞬态，终态后由历史读取替换）。
import { useState, useEffect, useRef, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { estimateTextTokens } from '@ema-agent/token';
import { NarrativeStatusBlock } from '@ema-agent/builtin-tools/ui';
import type { AssistantBlock } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import { Markdown } from '../../markdown/renderer.js';
import { ToolCallBlock } from './toolBlocks/ToolCallBlock.js';
import { replayTurn, stopPlayback, usePlaybackStore } from '../../lib/tts-playback.js';
import { showToast } from '../../lib/toast.js';
import { useSessionStore } from '../../stores/session.js';
import { WorkSection } from './toolBlocks/WorkSection.js';
import { ToolWorkGroup } from './toolBlocks/ToolWorkGroup.js';
import { EditedFilesCard } from './toolBlocks/EditedFilesCard.js';
import {
  editedFiles,
  formatTurnTime,
  groupWorkRows,
  isTextRow,
  splitWorkAnswer,
  type WorkRow,
} from './toolBlocks/workGroups.js';
import { type TurnMessageGroup } from './MessageBlocks.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import {
  sumTurnUsage,
  useLiveTurns,
  type LiveTurn,
} from '../state/liveTurns.js';

/** Ignore clicks landing within this window after the previous one (rage-click guard). */
const AUDIO_CLICK_THROTTLE_MS = 600;

function ForkButton({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedSessionId = useChatWorkspace((state) => state.viewedSessionId);
  if (!viewedSessionId) return null;

  const handleFork = async (): Promise<void> => {
    try {
      const newSessionId = await useSessionStore
        .getState()
        .forkSession(viewedSessionId, turnId);
      await useChatWorkspace.getState().viewSession(newSessionId);
      showToast('已从该回复创建新会话');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '创建新会话失败',
        { variant: 'danger' },
      );
    }
  };

  return (
    <IconButton
      size="sm"
      icon="i-lucide:git-fork"
      label="从该回复创建新会话"
      className="chat-icon-btn"
      onClick={() => void handleFork()}
    />
  );
}

// ── 共享主体：工作区段 + 回答段 + 变更卡 ──────────────────────────────────────

function BubbleBody({
  rows, streaming, turnId, createdAt, durationMs,
}: {
  rows: readonly WorkRow[];
  streaming: boolean;
  turnId?: string;
  createdAt: number;
  durationMs?: number;
}): JSX.Element {
  const { work, answer } = splitWorkAnswer(groupWorkRows(rows));
  const edited = editedFiles(rows);

  const renderGroup = (group: (typeof work)[number], index: number): JSX.Element =>
    group.kind === 'tool_group' ? (
      <ToolWorkGroup key={index} rows={group.rows} streaming={streaming} turnId={turnId} />
    ) : (
      <RowRenderer key={index} row={group.row} streaming={streaming} turnId={turnId} />
    );

  return (
    <div className="text-sm break-words flex flex-col gap-2 text-[var(--ema-text-secondary)]">
      {work.length > 0 && (
        <WorkSection
          rows={rows}
          streaming={streaming}
          {...(durationMs !== undefined ? { durationMs } : {})}
          createdAt={createdAt}
        >
          {work.map(renderGroup)}
        </WorkSection>
      )}
      {answer.map(renderGroup)}
      {edited.files.length > 0 && (
        <EditedFilesCard files={edited.files} additions={edited.additions} deletions={edited.deletions} />
      )}
    </div>
  );
}

function RowRenderer({
  row, streaming, turnId,
}: {
  row: WorkRow;
  streaming: boolean;
  turnId?: string;
}): JSX.Element {
  if (row.source === 'history') {
    const block = row.block;
    switch (block.type) {
      case 'text':
        return <Markdown source={block.text} />;
      case 'thinking':
      case 'reasoning':
      case 'gemini_thought':
        // 思考族当前不进气泡正文（页脚运行信号已有 thinking 指示）。
        return <></>;
      case 'tool_use':
        return (
          <ToolCallBlock
            row={{ source: 'history', block, ...(row.toolResult ? { toolResult: row.toolResult } : {}) }}
            streaming={streaming}
            turnId={turnId}
          />
        );
      default: {
        // 后端 AssistantBlock 新增成员在这里编译报警，不允许静默忽略。
        const exhaustive: never = block;
        return <>{JSON.stringify(exhaustive)}</>;
      }
    }
  }
  const item = row.item;
  switch (item.type) {
    case 'text':
      return <Markdown source={item.text} />;
    case 'thinking':
      return <></>;
    case 'tool_use':
      return <ToolCallBlock row={{ source: 'stream', item }} streaming={streaming} turnId={turnId} />;
    case 'narrative_status':
      return <NarrativeStatusBlock data={item} />;
    default:
      return <></>;
  }
}

// ── 历史气泡 ──────────────────────────────────────────────────────────────────

export interface AssistantMessageProps {
  group: TurnMessageGroup;
  toolResults: ReadonlyMap<string, ToolResult>;
  canFork?: boolean;
}

export function AssistantMessage({ group, toolResults, canFork = false }: AssistantMessageProps): JSX.Element {
  const rows: WorkRow[] = group.messages.flatMap((message) => {
    if (!Array.isArray(message.blocks)) return [];
    return (message.blocks as AssistantBlock[]).map((block) => ({
      source: 'history' as const,
      block,
      ...(block.type === 'tool_use' && toolResults.has(block.id)
        ? { toolResult: toolResults.get(block.id)! }
        : {}),
    }));
  });

  const textContent = rows.filter(isTextRow).map((row) =>
    row.source === 'history' && row.block.type === 'text' ? row.block.text : '',
  ).join('');
  const lastMessage = group.messages[group.messages.length - 1];
  const createdAt = lastMessage?.createdAt ?? Date.now();

  return (
    <div className="flex mr-12 ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full">
        {rows.length > 0 && (
          <BubbleBody
            rows={rows}
            streaming={false}
            turnId={group.turnId ?? undefined}
            createdAt={createdAt}
          />
        )}
        <BubbleFooter
          textContent={textContent}
          turnId={group.turnId}
          createdAt={createdAt}
          isStreaming={false}
          canFork={canFork}
        />
      </div>
    </div>
  );
}

// ── 流式气泡 ──────────────────────────────────────────────────────────────────

export function StreamingAssistantMessage({ stream }: { stream: LiveTurn }): JSX.Element {
  const rows: WorkRow[] = stream.items.map((item) => ({ source: 'stream' as const, item }));
  const isEmpty = rows.length === 0;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setElapsed(Math.round((Date.now() - stream.startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [stream.startedAt]);

  const liveUsage = useLiveTurns((state) => sumTurnUsage(state, stream.turnId));
  const outputEstimated = (liveUsage?.outputTokens ?? 0) === 0;
  const textContent = stream.items
    .filter((item) => item.type === 'text')
    .map((item) => (item as { text: string }).text)
    .join('');
  const displayedOutputTokens = outputEstimated
    ? estimateTextTokens(textContent)
    : liveUsage?.outputTokens ?? 0;

  return (
    <div className="flex mr-12 ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full">
        {isEmpty ? (
          <div className="flex gap-1.5 items-center h-4 py-2">
            <div className="w-1.5 h-1.5 rounded-full animate-bounce bg-[var(--ema-text-secondary)]" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full animate-bounce bg-[var(--ema-text-secondary)]" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full animate-bounce bg-[var(--ema-text-secondary)]" style={{ animationDelay: '300ms' }} />
          </div>
        ) : (
          <BubbleBody rows={rows} streaming turnId={stream.turnId} createdAt={stream.startedAt} />
        )}
        <BubbleFooter
          textContent={textContent}
          turnId={stream.turnId}
          executionProfile={stream.executionProfile}
          narrativePolicy={stream.narrativePolicy}
          elapsedSeconds={elapsed}
          liveInputTokens={liveUsage?.inputTokens}
          liveOutputTokens={displayedOutputTokens}
          liveOutputEstimated={outputEstimated}
          thinkingActive={stream.thinkingActive}
          isStreaming
          canFork={false}
        />
      </div>
    </div>
  );
}

// ── 页脚 ──────────────────────────────────────────────────────────────────────

function BubbleFooter({
  textContent,
  turnId,
  executionProfile,
  narrativePolicy,
  inputTokens,
  outputTokens,
  durationMs,
  createdAt,
  isStreaming,
  canFork,
  elapsedSeconds,
  liveInputTokens,
  liveOutputTokens,
  liveOutputEstimated = false,
  thinkingActive = false,
}: {
  textContent: string;
  turnId: string | null;
  executionProfile?: string;
  narrativePolicy?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  createdAt?: number;
  isStreaming: boolean;
  canFork: boolean;
  elapsedSeconds?: number;
  liveInputTokens?: number;
  liveOutputTokens?: number;
  liveOutputEstimated?: boolean;
  thinkingActive?: boolean;
}): JSX.Element {
  const playingTurnId = usePlaybackStore((s) => s.playingTurnId);
  const isPlayingThis = !!turnId && playingTurnId === turnId;
  const lastAudioClickRef = useRef(0);
  const [copied, setCopied] = useState(false);

  const handleAudioClick = (): void => {
    const now = Date.now();
    if (now - lastAudioClickRef.current < AUDIO_CLICK_THROTTLE_MS) return;
    lastAudioClickRef.current = now;
    if (isPlayingThis) {
      stopPlayback();
      return;
    }
    if (!turnId) return;
    void replayTurn(turnId).catch(() => {
      // 404 = this turn produced no audio (TTS off / aborted) — not an error.
      showToast('该轮没有可重播的语音', { variant: 'warning' });
    });
  };

  const showAudioButton = !!turnId && (isPlayingThis || !isStreaming);

  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
      {/* Turn 执行档位；Narrative 是检索策略，不显示成第三种模式。 */}
      {executionProfile && (
        <span className={`px-1.5 py-0.5 rounded-md font-medium
          ${executionProfile === 'work'
            ? 'bg-[var(--ema-info-muted)] text-[var(--ema-info)]'
            : 'bg-[var(--ema-surface-3)] text-[var(--ema-text-tertiary)]'}`}>
          {executionProfile === 'work' ? 'Work' : 'Chat'}
          {narrativePolicy === 'always' ? ' · 剧情常开' : ''}
        </span>
      )}

      {isStreaming && (
        <span className="flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full animate-pulse shrink-0 bg-[var(--ema-primary)]" />
          <span className="tabular-nums">{elapsedSeconds ?? 0}s</span>
          {liveInputTokens != null && liveInputTokens > 0 && (
            <span className="tabular-nums text-[var(--ema-text-tertiary)]">↑{fmtTok(liveInputTokens)}</span>
          )}
          {liveOutputTokens != null && liveOutputTokens > 0 && (
            <span className="tabular-nums">
              {liveOutputEstimated ? '≈↓' : '↓'}{fmtTok(liveOutputTokens)}
            </span>
          )}
          {thinkingActive && <span className="text-[var(--ema-info)]">· thinking</span>}
        </span>
      )}

      {!isStreaming && (inputTokens !== undefined || textContent) && (
        <span className="flex items-center gap-1.5 tabular-nums">
          {inputTokens !== undefined ? (
            <>
              <span>↑{fmtTok(inputTokens)}</span>
              <span className="tabular-nums text-[var(--ema-text-tertiary)]">·</span>
              <span>↓{fmtTok(outputTokens ?? 0)}</span>
              {durationMs !== undefined && (
                <>
                  <span className="tabular-nums text-[var(--ema-text-tertiary)]">·</span>
                  <span>{(durationMs / 1000).toFixed(1)}s</span>
                </>
              )}
            </>
          ) : (
            <span className="text-[var(--ema-text-tertiary)]">≈↓{fmtTok(estimateTextTokens(textContent))}</span>
          )}
        </span>
      )}

      {showAudioButton && (
        <IconButton
          size="sm"
          label={isPlayingThis ? '停止播放' : '重播语音'}
          icon={isPlayingThis ? 'i-lucide:square' : 'i-lucide:rotate-ccw'}
          className="chat-icon-btn -ml-0.5"
          onClick={handleAudioClick}
        />
      )}

      {!isStreaming && textContent && (
        <IconButton
          size="sm"
          label="复制"
          icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
          className="chat-icon-btn"
          onClick={() => {
            void navigator.clipboard.writeText(textContent).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1000);
            });
          }}
        />
      )}

      {!isStreaming && canFork && turnId && <ForkButton turnId={turnId} />}

      {!isStreaming && createdAt !== undefined && (
        <span className="ml-auto opacity-50 tabular-nums">{formatTurnTime(createdAt)}</span>
      )}
    </div>
  );
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
