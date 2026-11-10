import { create } from 'zustand';
import type { AudioSegment, CharacterTag, SpeechAudioIdentity, SpeechGenerationEvent } from '@ema-agent/speech';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { audioApi } from '../api/audio.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import type { CaptionState } from '../lib/tauri/types.js';
import { showToast } from '../lib/notifications/toast.js';
import { subscribeSpeechGeneration, useAudioStore } from './audio.js';
import * as speechPlayback from '../speech/speechPlayback.js';
import type { SpeechPlaybackCallbacks } from '../speech/speechPlayback.js';

interface PresentationOwner {
  readonly sessionId: string;
  readonly turnId: string;
}

interface BeginTurnPresentationInput extends PresentationOwner {
  readonly ttsEnabled: boolean;
  readonly audioId?: string | null;
  readonly characterName?: string;
}

interface PlaySavedAudioInput {
  readonly sessionId: string;
  readonly audioId: string;
}

interface AudioPlaybackState {
  /** 唯一允许驱动角色的 Turn, 新 Turn 不分 Session 都直接接管. */
  readonly owner: PresentationOwner | null;
  readonly audioId: string | null;
  /**
   * null 时当前 owner 可接收纯文字展示; loading 包含等待首段声音和播放中缓冲.
   * loading/playing 都由播放器提供字幕和标签, appendText 不接管展示.
   */
  readonly playbackStatus: 'loading' | 'playing' | null;
  readonly caption: CaptionState;
  beginTurnPresentation(input: BeginTurnPresentationInput): void;
  appendText(sessionId: string, turnId: string, text: string, tags: readonly CharacterTag[] | null): void;
  finishTurn(sessionId: string, turnId: string): void;
  receiveSpeechEvent(event: SpeechGenerationEvent): void;
  playSavedAudio(input: PlaySavedAudioInput): Promise<void>;
  stopPlayback(): void;
  stopAudio(audioId: string): void;
  removeTurn(sessionId: string, turnId: string): void;
  clearSessionPlayback(sessionId: string): void;
}

const MAX_TEXT_CHARACTERS = 500;
// 只用于合并纯文字字幕的跨窗口通知, 不是播放器检查间隔或字幕同步精度.
const TEXT_UPDATE_INTERVAL_MS = 50;
let textUpdateTimer: ReturnType<typeof setTimeout> | undefined;
// 对象身份使旧查询失效; SessionID 和 AudioID 用于在删除期间撤销尚未返回的重播选择.
let replayRequest: PlaySavedAudioInput | null = null;

function publishCaption(): void {
  clearTimeout(textUpdateTimer);
  textUpdateTimer = undefined;
  void tauriBridge.publishCaptionState(useAudioPlaybackStore.getState().caption);
}

function saveCaption(caption: CaptionState, shouldDelay = false): void {
  useAudioPlaybackStore.setState({ caption });
  if (shouldDelay) textUpdateTimer ??= setTimeout(publishCaption, TEXT_UPDATE_INTERVAL_MS);
  else publishCaption();
}

function owns(owner: PresentationOwner): boolean {
  const current = useAudioPlaybackStore.getState().owner;
  return current?.sessionId === owner.sessionId && current.turnId === owner.turnId;
}

function executeTags(tags: readonly CharacterTag[]): void {
  for (const tag of tags) {
    if (tag.type === 'emotion') void tauriBridge.publishStageEmotion(tag.emotion);
    else void tauriBridge.publishStageMotion(tag.motion);
  }
}

function playbackCallbacks(identity: SpeechAudioIdentity): SpeechPlaybackCallbacks {
  // 回调属于 identity.audioId, 切换 Turn 或录音后, 旧播放器的迟到报告不能再更新字幕或 Stage.
  const isCurrent = (): boolean => owns(identity) && useAudioPlaybackStore.getState().audioId === identity.audioId;
  return {
    onStatus(playbackStatus) {
      if (isCurrent()) useAudioPlaybackStore.setState({ playbackStatus });
    },
    onCaption(segment: AudioSegment) {
      if (!isCurrent() || segment.textForTTS === null) return;
      const previous = useAudioPlaybackStore.getState().caption;
      saveCaption({
        kind: 'speech', ...identity, segmentIndex: segment.segmentIndex,
        text: segment.textForTTS, playing: true, revision: previous.revision + 1,
      });
    },
    onCaptionPlaying(isPlaying) {
      const previous = useAudioPlaybackStore.getState().caption;
      if (isCurrent() && previous.kind === 'speech' && previous.playing !== isPlaying) {
        saveCaption({ ...previous, playing: isPlaying, revision: previous.revision + 1 });
      }
    },
    onTags(tags) {
      if (isCurrent()) executeTags(tags);
    },
    onEnded() {
      if (!isCurrent()) return;
      // 自然结束只清当前播放, 不作废用户正在等待的另一条重播查询.
      useAudioPlaybackStore.setState({ owner: null, audioId: null, playbackStatus: null });
      saveCaption({ kind: 'hidden', revision: useAudioPlaybackStore.getState().caption.revision + 1 });
    },
  };
}

export const useAudioPlaybackStore = create<AudioPlaybackState>((set, get) => ({
  owner: null,
  audioId: null,
  playbackStatus: null,
  caption: { kind: 'hidden', revision: 0 },

  beginTurnPresentation(input) {
    get().stopPlayback();
    set({ owner: { sessionId: input.sessionId, turnId: input.turnId } });
    if (!input.ttsEnabled) return;
    if (!input.audioId || !input.characterName) {
      showToast('本轮语音未能启动, 继续显示文字回复', { variant: 'warning' });
      return;
    }
    const identity: SpeechAudioIdentity = {
      sessionId: input.sessionId, turnId: input.turnId,
      audioId: input.audioId, characterName: input.characterName,
    };
    // 首段声音到达前就交给语音播放路径, 防止等待期间 appendText 抢先显字和执行标签.
    set({ audioId: identity.audioId, playbackStatus: 'loading' });
    speechPlayback.startAutomaticPlayback(identity, playbackCallbacks(identity));
  },

  appendText(sessionId, turnId, text, tags) {
    // 仅当前 owner 的纯文字展示接收 LLM 增量. 等待或播放音频时, 字幕和标签由播放器回调提供.
    if (!owns({ sessionId, turnId }) || get().playbackStatus !== null) return;
    if (text) {
      const previous = get().caption;
      const accumulated = previous.kind === 'text' && previous.turnId === turnId ? previous.text + text : text;
      saveCaption({
        kind: 'text', sessionId, turnId,
        text: Array.from(accumulated).slice(-MAX_TEXT_CHARACTERS).join(''),
        revision: previous.revision + 1,
      }, true);
    }
    if (tags) executeTags(tags);
  },

  finishTurn(sessionId, turnId) {
    if (!owns({ sessionId, turnId }) || get().playbackStatus !== null) return;
    // 纯文字完成时发送最后正文, 视图保留阅读时间. 主窗口同时释放 owner.
    publishCaption();
    set({ owner: null, caption: { kind: 'hidden', revision: get().caption.revision + 1 } });
  },

  receiveSpeechEvent(event) {
    if (event.audioId === get().audioId) speechPlayback.receiveSpeechEvent(event);
  },

  async playSavedAudio(input) {
    const request = { ...input };
    replayRequest = request;
    try {
      const playback = await audioApi.loadAudioPlayback(request.audioId);
      if (replayRequest !== request) return;
      get().stopPlayback();
      set({
        owner: { sessionId: playback.sessionId, turnId: playback.turnId },
        audioId: request.audioId, playbackStatus: 'loading',
      });
      speechPlayback.startSavedPlayback(playback, playbackCallbacks(playback));
    } catch (error) {
      if (replayRequest === request) showToast(error instanceof Error ? error.message : '无法读取音频', { variant: 'warning' });
    } finally {
      if (replayRequest === request) replayRequest = null;
    }
  },

  stopPlayback() {
    replayRequest = null;
    speechPlayback.stopPlayback();
    set({ owner: null, audioId: null, playbackStatus: null });
    saveCaption({ kind: 'hidden', revision: get().caption.revision + 1 });
  },

  stopAudio(audioId) {
    if (replayRequest?.audioId === audioId) replayRequest = null;
    if (get().audioId === audioId) get().stopPlayback();
  },

  removeTurn(sessionId, turnId) {
    if (owns({ sessionId, turnId })) get().stopPlayback();
  },

  clearSessionPlayback(sessionId) {
    // 查询尚未返回时 owner 仍可能属于另一会话, 不能只依靠当前播放身份取消这个选择.
    if (replayRequest?.sessionId === sessionId) replayRequest = null;
    if (get().owner?.sessionId === sessionId) get().stopPlayback();
  },
}));

export function receiveAudioPlaybackSystemEvent(event: AppEvent): void {
  if (event.type === 'sessions_deleted') {
    for (const sessionId of event.sessionIds) useAudioPlaybackStore.getState().clearSessionPlayback(sessionId);
  } else if (event.type === 'session_audio_changed' && event.audioStatus !== 'ready' && event.audioStatus !== 'generating') {
    useAudioPlaybackStore.getState().stopAudio(event.audioId);
  }
}

/** 主窗口挂载一次. 不在导入模块时监听, 切换页面不触发此清理. */
export function mountAudioPlayback(): () => void {
  const stopSpeech = subscribeSpeechGeneration(event => useAudioPlaybackStore.getState().receiveSpeechEvent(event));
  const stopDeletion = useAudioStore.subscribe((current, previous) => {
    for (const audioId of current.deletionRequests.keys()) {
      if (!previous.deletionRequests.has(audioId)) useAudioPlaybackStore.getState().stopAudio(audioId);
    }
  });
  const captionRequest = tauriBridge.listenCaptionStateRequest(publishCaption);
  return () => {
    stopSpeech();
    stopDeletion();
    void captionRequest.then(unlisten => unlisten());
    useAudioPlaybackStore.getState().stopPlayback();
    speechPlayback.closeSpeechPlayback();
  };
}
