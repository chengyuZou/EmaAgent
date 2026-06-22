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
import { sessionsApi } from '../api/sessions.js';

export interface AssistantBubbleProps {
  message:         Pick<ChatHistoryItem, 'content' | 'slices' | 'createdAt' | 'stats' | 'turnId' | 'mode'>;
  label?:       string;
  isStreaming?: boolean;
}

/** Ignore clicks landing within this window after the previous one (rage-click guard). */
const AUDIO_CLICK_THROTTLE_MS = 600;

export function AssistantBubble({ message, label = 'Ema', isStreaming }: AssistantBubbleProps): JSX.Element {
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
        <div className="text-xs text-white/40 font-normal mb-1">
          <span>{label}</span>
        </div>

        {isEmpty && isStreaming ? (
          <div className="flex gap-1.5 items-center h-4 py-2">
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        ) : (
          <div className="text-neutral-200 text-sm break-words flex flex-col gap-2">
            {groupSlices(slices).map((group, gi) => {
              if (group.kind === 'tool_group') {
                return (
                  <div
                    key={gi}
                    className="rounded-xl border border-neutral-800/60 bg-transparent px-3 py-2 flex flex-col gap-1.5"
                  >
                    {group.slices.map((slice, si) => (
                      <SliceRenderer key={si} slice={slice} streaming={!!isStreaming} />
                    ))}
                  </div>
                );
              }
              return <SliceRenderer key={gi} slice={group.slice} streaming={!!isStreaming} />;
            })}
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500">
          {/* Mode chip */}
          {message.mode && (
            <span className={`px-1.5 py-0.5 rounded-md font-medium
              ${message.mode === 'agent'     ? 'bg-violet-500/15 text-violet-400/80'
              : message.mode === 'narrative' ? 'bg-amber-500/15 text-amber-400/80'
              :                                'bg-neutral-700/50 text-neutral-400/70'}`}>
              {message.mode === 'agent' ? 'Agent' : message.mode === 'narrative' ? '叙事' : 'Chat'}
            </span>
          )}

          {/* Live streaming stats */}
          {isStreaming && (
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-primary-400 animate-pulse shrink-0" />
              <span className="tabular-nums">{elapsed}s</span>
              {estimatedIn != null && estimatedIn > 0 && (
                <span className="tabular-nums text-neutral-600">↑{fmtTok(estimatedIn)}</span>
              )}
              {estimatedOut != null && estimatedOut > 0 && (
                <span className="tabular-nums">↓{fmtTok(estimatedOut)}</span>
              )}
              {thinkingActive && <span className="text-violet-400/70">· thinking</span>}
            </span>
          )}

          {/* Final stats */}
          {!isStreaming && (message.stats || message.content) && (
            <span className="flex items-center gap-1.5 tabular-nums">
              {message.stats ? (
                <>
                  <span>↑{fmtTok(message.stats.inputTokens)}</span>
                  <span className="text-neutral-700">·</span>
                  <span>↓{fmtTok(message.stats.outputTokens)}</span>
                  <span className="text-neutral-700">·</span>
                  <span>{(message.stats.durationMs / 1000).toFixed(1)}s</span>
                </>
              ) : (
                <span className="text-neutral-600">≈↓{fmtTok(estimateTextTokens(message.content))}</span>
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

          {/* Branch sibling navigation ‹ N/M › */}
          {!isStreaming && message.turnId && (
            <BranchSiblingNav turnId={message.turnId as string} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Branch sibling navigator ‹ N/M › ─────────────────────────────────────────

function BranchSiblingNav({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId   = useConversationStore((s) => s.viewedSessionId);
  const branchData = useConversationStore((s) =>
    viewedId ? s.branchDataBySession.get(viewedId as string) : undefined,
  );

  if (!branchData || !viewedId) return null;

  const siblings = branchData.branches
    .filter((b) => (b.forkFromTurnId as string) === turnId)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (siblings.length < 2) return null;

  const activeIdx = siblings.findIndex((b) => b.isActive);
  if (activeIdx < 0) return null;

  const pos   = activeIdx + 1;
  const total = siblings.length;

  const navigate = async (delta: -1 | 1): Promise<void> => {
    const next = siblings[activeIdx + delta];
    if (!next) return;
    try {
      await sessionsApi.switchBranch(viewedId, next.branchId);
      await useConversationStore.getState().loadBranches(viewedId);
      // Evict + reload messages so the switched branch history appears.
      useConversationStore.setState((s) => {
        const m = new Map(s.messages);
        m.delete(viewedId as string);
        return { messages: m };
      });
      await useConversationStore.getState().loadMessages(viewedId);
    } catch { /* non-critical */ }
  };

  return (
    <span className="flex items-center gap-0.5 ml-1">
      <button
        className="w-3.5 h-3.5 flex items-center justify-center text-neutral-500 hover:text-neutral-200 disabled:opacity-25 transition-colors leading-none"
        disabled={pos === 1}
        onClick={() => void navigate(-1)}
        title="上一个分支"
      >‹</button>
      <span className="tabular-nums text-[10px] text-neutral-500">{pos}/{total}</span>
      <button
        className="w-3.5 h-3.5 flex items-center justify-center text-neutral-500 hover:text-neutral-200 disabled:opacity-25 transition-colors leading-none"
        disabled={pos === total}
        onClick={() => void navigate(1)}
        title="下一个分支"
      >›</button>
    </span>
  );
}

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
