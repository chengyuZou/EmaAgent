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
  message:         Pick<ChatHistoryItem, 'content' | 'slices' | 'createdAt' | 'stats' | 'turnId'>;
  label?:          string;
  isStreaming?:    boolean;
  iterationCount?: number;
}

/** Ignore clicks landing within this window after the previous one (rage-click guard). */
const AUDIO_CLICK_THROTTLE_MS = 600;

export function AssistantBubble({ message, label = 'Ema', isStreaming, iterationCount }: AssistantBubbleProps): JSX.Element {
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
    <div className="flex mr-12">
      <div className="flex flex-col min-w-20 max-w-full">
        <div className="text-xs text-white/50 font-normal mb-1 flex items-center gap-1.5">
          <span>{label}</span>
          {isStreaming && iterationCount != null && iterationCount > 0 && (
            <span className="text-violet-400/70">第 {iterationCount} 轮</span>
          )}
        </div>

        {isEmpty && isStreaming ? (
          <div className="flex gap-1.5 items-center h-4 py-2">
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        ) : (
          <div className="text-neutral-200 text-sm break-words flex flex-col gap-2">
            {slices.map((slice, i) => (
              <SliceRenderer key={i} slice={slice} streaming={!!isStreaming} />
            ))}
          </div>
        )}

        {((!isStreaming && message.stats) || isStreaming || showAudioButton) && (
          <div className="text-xs text-neutral-400 mt-1 flex items-center gap-2">
            {!isStreaming && message.stats ? (
              <span>
                ↑ {message.stats.inputTokens.toLocaleString()} tokens
                {' '}↓ {message.stats.outputTokens.toLocaleString()} tokens
                {' '}· {(message.stats.durationMs / 1000).toFixed(1)}s
              </span>
            ) : isStreaming && (
              <span className="flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-primary-400 animate-pulse" />
                {elapsed > 0 && <span>· {elapsed}s</span>}
                {estimatedIn != null && estimatedIn > 0 && (
                  <span>· ↑{estimatedIn.toLocaleString()}</span>
                )}
                {estimatedOut != null && estimatedOut > 0 && (
                  <span>· ↓{estimatedOut.toLocaleString()}</span>
                )}
                {thinkingActive && <span className="text-violet-400/80">· Thinking</span>}
              </span>
            )}
            {showAudioButton && (
              <IconButton
                size="sm"
                label={isPlayingThis ? '停止播放' : '播放语音'}
                icon={isPlayingThis ? 'i-mdi:stop' : 'i-mdi:play'}
                className="opacity-40 hover:opacity-100"
                onClick={handleAudioClick}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function resolveSlices(msg: { content: string; slices?: AssistantSlice[] }): AssistantSlice[] {
  if (msg.slices && msg.slices.length > 0) return msg.slices;
  if (msg.content) return [{ type: 'text', text: msg.content }];
  return [];
}

function SliceRenderer({ slice, streaming }: { slice: AssistantSlice; streaming: boolean }): JSX.Element {
  switch (slice.type) {
    case 'text':
      return <Markdown source={slice.text} />;
    case 'thinking':
      return <></>;
    case 'tool_use':
      return <ToolCallBlock slice={slice} streaming={streaming} />;
    case 'narrative_status':
      return <NarrativeStatusBlock slice={slice} />;
    default:
      return <></>;
  }
}
