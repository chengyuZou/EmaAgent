/**
 * AssistantBubble — left-aligned assistant message. Layout from AIRI assistant-item.vue,
 * colors kept as original EmaAgent gray.
 */
import { useState, useEffect, useRef, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { estimateTextTokens } from '@ema-agent/token';
import { Markdown } from '../markdown/renderer.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { NarrativeStatusBlock } from './NarrativeStatusBlock.js';
import { replayTurn, stopPlayback, usePlaybackStore } from '../lib/tts-playback.js';
import { showToast } from '../lib/toast.js';
import { useConversationStore, type ChatHistoryItem, type AssistantSlice } from '../stores/conversation-store.js';

export interface AssistantBubbleProps {
  message:         Pick<ChatHistoryItem, 'content' | 'slices' | 'createdAt' | 'stats' | 'turnId' | 'mode'>;
  label?:       string;
  isStreaming?: boolean;
}

/** Ignore clicks landing within this window after the previous one (rage-click guard). */
const AUDIO_CLICK_THROTTLE_MS = 600;

export function AssistantBubble({ message, isStreaming }: AssistantBubbleProps): JSX.Element {
  const slices = resolveSlices(message);
  const isEmpty = slices.length === 0;

  const playingTurnId = usePlaybackStore((s) => s.playingTurnId);
  const isPlayingThis = !!message.turnId && playingTurnId === (message.turnId as string);
  const lastAudioClickRef = useRef(0);

  const handleAudioClick = (): void => {
    const now = Date.now();
    if (now - lastAudioClickRef.current < AUDIO_CLICK_THROTTLE_MS) return;
    lastAudioClickRef.current = now;

    if (isPlayingThis) {
      stopPlayback();
      return;
    }
    void replayTurn(message.turnId as string).catch(() => {
      // 404 = this turn produced no audio (TTS off / aborted) — not an error.
      showToast('该轮没有可重播的语音', { variant: 'warning' });
    });
  };

  // Streaming bubble: only the stop square while its audio is live.
  // Finished bubble: play triangle, which toggles to stop while replaying.
  // ── Live elapsed time during streaming ──────────────────────────────────
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isStreaming) { setElapsed(0); return; }
    const id = setInterval(() => setElapsed(Math.round((Date.now() - message.createdAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isStreaming, message.createdAt]);

  // Real provider usage if available, else estimate from content
  const liveUsage = useConversationStore((s) =>
    message.turnId ? s.liveUsageMap.get((message.turnId as string)) : undefined,
  );
  const thinkingActive = useConversationStore((s) =>
    message.turnId ? s.thinkingActiveMap.get((message.turnId as string)) : false,
  );
  const estimatedOut = isStreaming ? (liveUsage?.outputTokens ?? estimateTextTokens(message.content)) : null;
  const estimatedIn  = isStreaming ? liveUsage?.inputTokens : null;

  const showAudioButton = !!message.turnId && (isPlayingThis || !isStreaming);

  return (
    <div className="flex mr-12 ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full">
        {isEmpty && isStreaming ? (
          <div className="flex gap-1.5 items-center h-4 py-2">
            <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--ema-text-secondary)', animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--ema-text-secondary)', animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--ema-text-secondary)', animationDelay: '300ms' }} />
          </div>
        ) : (
          <div className="text-sm break-words flex flex-col gap-2" style={{ color: 'var(--ema-text-secondary)' }}>
            {groupSlices(slices).map((group, gi) => {
              if (group.kind === 'tool_group') {
                return (
                  <div
                    key={gi}
                    className="rounded-xl border bg-transparent px-3 py-2 flex flex-col gap-1.5"
                    style={{ borderColor: 'var(--ema-border)' }}
                  >
                    {group.slices.map((slice, si) => (
                      <SliceRenderer key={si} slice={slice} streaming={!!isStreaming} turnId={message.turnId as string | undefined} />
                    ))}
                  </div>
                );
              }
              return <SliceRenderer key={gi} slice={group.slice} streaming={!!isStreaming} turnId={message.turnId as string | undefined} />;
            })}
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-2 text-[11px]" style={{ color: 'var(--ema-text-tertiary)' }}>
          {/* Mode chip */}
          {message.mode && (
            <span className={`px-1.5 py-0.5 rounded-md font-medium
              ${message.mode === 'agent'     ? 'bg-[var(--ema-info-muted)] text-[var(--ema-info)]'
              : message.mode === 'narrative' ? 'bg-[var(--ema-warning-muted)] text-[var(--ema-warning)]'
              :                                'bg-[var(--ema-surface-3)] text-[var(--ema-text-tertiary)]'}`}>
              {message.mode === 'agent' ? 'Agent' : message.mode === 'narrative' ? '叙事' : 'Chat'}
            </span>
          )}

          {/* Live streaming stats */}
          {isStreaming && (
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full animate-pulse shrink-0" style={{ background: 'var(--ema-primary)' }} />
              <span className="tabular-nums">{elapsed}s</span>
              {estimatedIn != null && estimatedIn > 0 && (
                <span className="tabular-nums" style={{ color: 'var(--ema-text-tertiary)' }}>↑{fmtTok(estimatedIn)}</span>
              )}
              {estimatedOut != null && estimatedOut > 0 && (
                <span className="tabular-nums">↓{fmtTok(estimatedOut)}</span>
              )}
              {thinkingActive && <span style={{ color: 'var(--ema-info)' }}>· thinking</span>}
            </span>
          )}

          {/* Final stats */}
          {!isStreaming && (message.stats || message.content) && (
            <span className="flex items-center gap-1.5 tabular-nums">
              {message.stats ? (
                <>
                  <span>↑{fmtTok(message.stats.inputTokens)}</span>
                  <span className="tabular-nums" style={{ color: 'var(--ema-text-tertiary)' }}>·</span>
                  <span>↓{fmtTok(message.stats.outputTokens)}</span>
                  <span className="tabular-nums" style={{ color: 'var(--ema-text-tertiary)' }}>·</span>
                  <span>{(message.stats.durationMs / 1000).toFixed(1)}s</span>
                </>
              ) : (
                <span style={{ color: 'var(--ema-text-tertiary)' }}>≈↓{fmtTok(estimateTextTokens(message.content))}</span>
              )}
            </span>
          )}

          {/* Replay button */}
          {showAudioButton && (
            <IconButton
              size="sm"
              label={isPlayingThis ? '停止播放' : '重播语音'}
              icon={isPlayingThis ? 'i-mdi:stop' : 'i-mdi:replay'}
              className="opacity-30 hover:opacity-80 -ml-0.5"
              onClick={handleAudioClick}
            />
          )}

        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Group consecutive tool_use slices into a shared box.
type SliceGroup =
  | { kind: 'tool_group'; slices: AssistantSlice[] }
  | { kind: 'single';     slice:  AssistantSlice   };

function groupSlices(slices: AssistantSlice[]): SliceGroup[] {
  const out: SliceGroup[] = [];
  let i = 0;
  while (i < slices.length) {
    const s = slices[i];
    if (!s) break;
    if (s.type === 'tool_use') {
      const group: AssistantSlice[] = [];
      while (i < slices.length) {
        const cur = slices[i];
        if (!cur || cur.type !== 'tool_use') break;
        group.push(cur);
        i++;
      }
      const first = group[0];
      if (group.length === 1 && first) {
        out.push({ kind: 'single', slice: first });
      } else {
        out.push({ kind: 'tool_group', slices: group });
      }
    } else {
      out.push({ kind: 'single', slice: s });
      i++;
    }
  }
  return out;
}

function resolveSlices(msg: { content: string; slices?: AssistantSlice[] }): AssistantSlice[] {
  if (msg.slices && msg.slices.length > 0) return msg.slices;
  if (msg.content) return [{ type: 'text', text: msg.content }];
  return [];
}

function SliceRenderer({ slice, streaming, turnId }: { slice: AssistantSlice; streaming: boolean; turnId?: string }): JSX.Element {
  switch (slice.type) {
    case 'text':
      return <Markdown source={slice.text} />;
    case 'thinking':
      return <></>;
    case 'tool_use':
      return <ToolCallBlock slice={slice} streaming={streaming} turnId={turnId} />;
    case 'narrative_status':
      return <NarrativeStatusBlock slice={slice} />;
    default:
      return <></>;
  }
}
