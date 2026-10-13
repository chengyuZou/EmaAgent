import { create } from 'zustand';
import { tauriBridge } from '../../lib/tauriBridge.js';

export interface SpeechTurnKey {
  readonly sessionId: string;
  readonly turnId: string;
}

export type PlaybackStatus = 'loading' | 'playing';

interface PresentationState {
  /** 首项拥有桌宠和播放器, 其余项是同一 Session 的待播 Turn. */
  readonly queue: readonly SpeechTurnKey[];
  /** null 表示没有音频 owner; 纯文字 Turn 仍可占首项驱动桌宠. */
  readonly playbackStatus: PlaybackStatus | null;
}

export const usePlaybackStore = create<PresentationState>(() => ({
  queue: [],
  playbackStatus: null,
}));

const DIALOGUE_FLUSH_MS = 50;
let pendingText = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function owns(sessionId: string, turnId: string): boolean {
  const owner = usePlaybackStore.getState().queue[0];
  return owner?.sessionId === sessionId && owner.turnId === turnId;
}

function discardPendingText(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingText = '';
}

function flushPendingText(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const owner = usePlaybackStore.getState().queue[0];
  if (!owner || pendingText.length === 0) return;
  const text = pendingText;
  pendingText = '';
  void tauriBridge.publishDialogueDelta(owner.sessionId, owner.turnId, text);
}

function replaceQueue(queue: readonly SpeechTurnKey[]): void {
  const previous = usePlaybackStore.getState().queue[0];
  discardPendingText();
  usePlaybackStore.setState({ queue, playbackStatus: queue.length > 0 ? 'loading' : null });
  if (previous) void tauriBridge.publishDialogueEnded(previous.sessionId, previous.turnId);
}

export const sessionPresentation = {
  /** 纯文字 Turn 只申请空闲 owner, 不进入待播队列. */
  claim(sessionId: string, turnId: string): boolean {
    if (usePlaybackStore.getState().queue.length > 0) return false;
    usePlaybackStore.setState({ queue: [{ sessionId, turnId }], playbackStatus: null });
    return true;
  },

  /** 不同 Session 在入口拒绝; 返回 true 表示新首项需要立即建立播放器. */
  enqueueSpeech(sessionId: string, turnId: string): boolean {
    const state = usePlaybackStore.getState();
    if (state.queue[0] && state.queue[0].sessionId !== sessionId) return false;
    if (state.queue.some(item => item.turnId === turnId && item.sessionId === sessionId)) return false;
    const startsNow = state.queue.length === 0;
    usePlaybackStore.setState({
      queue: [...state.queue, { sessionId, turnId }],
      playbackStatus: startsNow ? 'loading' : state.playbackStatus,
    });
    return startsNow;
  },

  setPlaybackStatus(sessionId: string, turnId: string, playbackStatus: PlaybackStatus): void {
    if (!owns(sessionId, turnId)) return;
    if (usePlaybackStore.getState().playbackStatus !== playbackStatus) {
      usePlaybackStore.setState({ playbackStatus });
    }
  },

  text(sessionId: string, turnId: string, delta: string): void {
    if (!owns(sessionId, turnId) || !delta) return;
    pendingText += delta;
    flushTimer ??= setTimeout(flushPendingText, DIALOGUE_FLUSH_MS);
  },

  emotion(sessionId: string, turnId: string, emotion: string): void {
    if (owns(sessionId, turnId)) void tauriBridge.publishStageEmotion(emotion);
  },

  motion(sessionId: string, turnId: string, motion: string): void {
    if (owns(sessionId, turnId)) void tauriBridge.publishStageMotion(motion);
  },

  /** 有音频时等实际播放结束, 不用生成完成来交接 owner. */
  finishTurn(sessionId: string, turnId: string): boolean {
    if (!owns(sessionId, turnId) || usePlaybackStore.getState().playbackStatus !== null) return false;
    flushPendingText();
    replaceQueue(usePlaybackStore.getState().queue.slice(1));
    return true;
  },

  playbackEnded(sessionId: string, turnId: string): void {
    if (owns(sessionId, turnId)) replaceQueue(usePlaybackStore.getState().queue.slice(1));
  },

  clearPlayback(): void {
    replaceQueue([]);
  },

  /** 手动重新生成只移除待播项, 不碰正在播放的首项. */
  removePendingTurn(sessionId: string, turnId: string): void {
    const state = usePlaybackStore.getState();
    const queue = state.queue.filter((item, index) => index === 0
      || item.sessionId !== sessionId || item.turnId !== turnId);
    if (queue.length !== state.queue.length) usePlaybackStore.setState({ queue });
  },

  removeTurn(sessionId: string, turnId: string): void {
    const state = usePlaybackStore.getState();
    const queue = state.queue.filter(item => item.sessionId !== sessionId || item.turnId !== turnId);
    if (queue.length === state.queue.length) return;
    if (owns(sessionId, turnId)) replaceQueue(queue);
    else usePlaybackStore.setState({ queue });
  },

  cancelSession(sessionId: string): void {
    const state = usePlaybackStore.getState();
    const queue = state.queue.filter(item => item.sessionId !== sessionId);
    if (queue.length === state.queue.length) return;
    if (state.queue[0]?.sessionId === sessionId) replaceQueue(queue);
    else usePlaybackStore.setState({ queue });
  },

  owns,
};
