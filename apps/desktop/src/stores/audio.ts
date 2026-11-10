import { useEffect } from 'react';
import { create } from 'zustand';
import type { SpeechAudioIdentity, SpeechGenerationEvent } from '@ema-agent/speech';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { turnsApi, type TurnAudioRecords } from '../api/turns.js';
import { audioApi } from '../api/audio.js';
import { openSpeechSocket, type SpeechSocketHandle } from '../api/speechWebSocket.js';
import { showToast } from '../lib/notifications/toast.js';

/** 描述一个正在生成的音频的状态 */
export interface AudioGeneration {
  readonly sessionId: string;
  readonly turnId: string;
  readonly characterName: string;
  /** 刚发起请求时可能为 null, 等后端返回或收到生成事件时才会补齐. */
  readonly audioId: string | null;
  readonly generationStatus: 'starting' | 'generating' | 'cancelling';
}

/** 某一轮对话(Turn)中所有音频的状态 */
export interface TurnAudioState {
  readonly sessionId: string;
  /** 首次读取成功前为 null, 刷新时保留旧列表. */
  readonly audioRecords: TurnAudioRecords | null;
  readonly readStatus: 'loading' | 'ready' | 'failed';
  readonly readFailureMessage: string | null;
}

interface GenerateTurnSpeechInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly characterName: string;
}

interface DeleteAudioInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly audioId: string;
}

interface AudioDeletionRequest {
  readonly sessionId: string;
  readonly turnId: string;
  /** HTTP 删除和列表核对都结束后完成, 同一 AudioID 的重复调用等待这个 Promise. */
  readonly deletionCompletion: Promise<void>;
}

interface AudioStoreState {
  readonly turnAudioByTurnId: ReadonlyMap<string, TurnAudioState>;
  /** 按 Turn 和角色登记前端正在跟踪的生成, 请求结束时移除; 关闭页面不取消生成. */
  readonly generationsByTurnAndCharacter: ReadonlyMap<string, AudioGeneration>;
  /** 界面用 Key 判断正在删除; 清理 Session 时提前移除登记, 不代表后端请求已取消. */
  readonly deletionRequests: ReadonlyMap<string, AudioDeletionRequest>;
  observeTurnAudio(sessionId: string, turnId: string): () => void;
  refreshTurnAudio(turnId: string): Promise<void>;
  generateTurnSpeech(input: GenerateTurnSpeechInput): Promise<void>;
  observeSpeechGeneration(identity: SpeechAudioIdentity): void;
  cancelSpeechGeneration(audioId: string): Promise<void>;
  deleteAudio(input: DeleteAudioInput): Promise<void>;
  clearSessionAudio(sessionId: string): void;
}

interface GenerationRequest {
  readonly input: GenerateTurnSpeechInput;
  audioId: string | null;
  socket: SpeechSocketHandle | null;
}

// 请求对象的身份用于拒绝旧结果, 通知连接留在这里; 界面读取 generationsByTurnAndCharacter.
const generationRequests = new Map<string, GenerationRequest>();
// 只登记打开的菜单或展开项, 最后一个界面离开后取消读取并释放列表.
const turnReaders = new Map<string, { observerCount: number; controller: AbortController | null }>();
const speechListeners = new Set<(event: SpeechGenerationEvent) => void>();

export function audioGenerationKey(turnId: string, characterName: string): string {
  return `${turnId}:${characterName}`;
}

export function subscribeSpeechGeneration(listener: (event: SpeechGenerationEvent) => void): () => void {
  speechListeners.add(listener);
  return () => { speechListeners.delete(listener); };
}

function publishSpeechEvent(event: SpeechGenerationEvent): void {
  for (const listener of speechListeners) listener(event);
}

function ownsRequest(request: GenerationRequest): boolean {
  const generationKey = audioGenerationKey(request.input.turnId, request.input.characterName);
  return generationRequests.get(generationKey) === request;
}

function saveGeneration(request: GenerationRequest, generationStatus: AudioGeneration['generationStatus']): void {
  const generationKey = audioGenerationKey(request.input.turnId, request.input.characterName);
  const generationsByTurnAndCharacter = new Map(useAudioStore.getState().generationsByTurnAndCharacter);
  generationsByTurnAndCharacter.set(generationKey, { ...request.input, audioId: request.audioId, generationStatus });
  useAudioStore.setState({ generationsByTurnAndCharacter });
}

function beginRequest(input: GenerateTurnSpeechInput, audioId: string | null): GenerationRequest | null {
  const generationKey = audioGenerationKey(input.turnId, input.characterName);
  if (generationRequests.has(generationKey)) return null;
  const request: GenerationRequest = { input, audioId, socket: null };
  generationRequests.set(generationKey, request);
  saveGeneration(request, audioId ? 'generating' : 'starting');
  return request;
}

function finishRequest(request: GenerationRequest): void {
  if (!ownsRequest(request)) return;
  const generationKey = audioGenerationKey(request.input.turnId, request.input.characterName);
  // 主动关闭通知连接也会触发 onClosed -> connectionFailed.
  // 此处移除 request 后, ownsRequest 会拒绝这次关闭通知, 避免显示断线提示.
  generationRequests.delete(generationKey);
  request.socket?.close();
  const generationsByTurnAndCharacter = new Map(useAudioStore.getState().generationsByTurnAndCharacter);
  generationsByTurnAndCharacter.delete(generationKey);
  useAudioStore.setState({ generationsByTurnAndCharacter });
}

function refreshObservedTurns(): void {
  for (const turnId of turnReaders.keys()) void useAudioStore.getState().refreshTurnAudio(turnId);
}

/**
 * 中断该 turnId 上一次仍在进行中的拉取请求
 * 确保当用户高频触发刷新时, 只有最后一次发起的请求能够生效
 */
function invalidateTurnRead(turnId: string): void {
  const reader = turnReaders.get(turnId);
  reader?.controller?.abort();
  if (reader) reader.controller = null;
}

export const useAudioStore = create<AudioStoreState>((set, get) => ({
  turnAudioByTurnId: new Map(),
  generationsByTurnAndCharacter: new Map(),
  deletionRequests: new Map(),

  observeTurnAudio(sessionId, turnId) {
    const reader = turnReaders.get(turnId);
    if (reader) reader.observerCount++;
    else {
      turnReaders.set(turnId, { observerCount: 1, controller: null });
      const turnAudioByTurnId = new Map(get().turnAudioByTurnId);
      turnAudioByTurnId.set(turnId, { sessionId, audioRecords: null, readStatus: 'loading', readFailureMessage: null });
      set({ turnAudioByTurnId });
      void get().refreshTurnAudio(turnId);
    }
    let isObserving = true;
    return () => {
      if (!isObserving) return;
      isObserving = false;
      const current = turnReaders.get(turnId);
      if (!current || --current.observerCount > 0) return;
      invalidateTurnRead(turnId);
      turnReaders.delete(turnId);
      const turnAudioByTurnId = new Map(get().turnAudioByTurnId);
      turnAudioByTurnId.delete(turnId);
      set({ turnAudioByTurnId });
    };
  },

  async refreshTurnAudio(turnId) {
    const reader = turnReaders.get(turnId);
    const current = get().turnAudioByTurnId.get(turnId);
    if (!reader || !current) return;
    invalidateTurnRead(turnId);
    const controller = new AbortController();
    reader.controller = controller;
    const save = (update: Partial<TurnAudioState>): void => {
      if (
        controller.signal.aborted || 
        turnReaders.get(turnId) !== reader || 
        reader.controller !== controller
      ) return;
      const latest = get().turnAudioByTurnId.get(turnId);
      if (!latest) return;
      set({ turnAudioByTurnId: new Map(get().turnAudioByTurnId).set(turnId, { ...latest, ...update }) });
    };
    save({ readStatus: 'loading', readFailureMessage: null });
    try {
      const audioRecords = await turnsApi.getAudioRecords(turnId, controller.signal);
      // 列表查询也能找回没收到 generating 通知的请求身份.
      if (!controller.signal.aborted && reader.controller === controller) {
        for (const audio of audioRecords) {
          if (audio.audioStatus !== 'generating') continue;
          const request = generationRequests.get(audioGenerationKey(turnId, audio.characterName));
          if (request && request.audioId === null) {
            request.audioId = audio.audioId;
            saveGeneration(request, 'generating');
          }
        }
      }
      save({ audioRecords, readStatus: 'ready' });
    } catch (error) {
      if (!controller.signal.aborted) {
        save({ readStatus: 'failed', readFailureMessage: error instanceof Error ? error.message : '音频列表读取失败' });
      }
    }
  },

  async generateTurnSpeech(input) {
    const request = beginRequest(input, null);
    if (!request) return;
    try {
      const result = await turnsApi.generateSpeech(input.turnId, input.characterName);
      if (!ownsRequest(request)) return;
      request.audioId = result.audioId;
      if (result.type === 'speech_generate_completed') showToast('语音已生成, 点击播放即可收听');
      else if (result.type === 'speech_generate_cancelled') showToast('已取消这次语音生成');
      else if (result.type === 'speech_generate_failed') showToast(result.message, { variant: 'warning' });
    } catch (error) {
      if (ownsRequest(request)) showToast(error instanceof Error ? error.message : '语音生成失败', { variant: 'warning' });
    } finally {
      finishRequest(request);
      void get().refreshTurnAudio(input.turnId);
    }
  },

  observeSpeechGeneration(identity) {
    const request = beginRequest(identity, identity.audioId);
    if (!request) return;
    const connectionFailed = (message: string): void => {
      if (!ownsRequest(request)) return;
      finishRequest(request);
      publishSpeechEvent({ type: 'speech_generate_unavailable', audioId: identity.audioId });
      showToast(message, { variant: 'warning' });
    };
    void openSpeechSocket(identity.audioId, {
      onControl(event) {
        if (!ownsRequest(request)) return;
        if (event.type === 'speech_generate_warning') showToast(event.message, { variant: 'warning' });
        if (event.type === 'speech_generate_completed' || event.type === 'speech_generate_cancelled'
          || event.type === 'speech_generate_failed' || event.type === 'speech_generate_unavailable') {
          finishRequest(request);
          if (event.type === 'speech_generate_failed') showToast(event.message, { variant: 'warning' });
        }
        publishSpeechEvent(event);
      },
      onClosed: () => connectionFailed('语音通知连接已断开, 后台生成未被取消'),
    }).then(socket => {
      if (ownsRequest(request)) request.socket = socket;
      else socket.close();
    }).catch(error => connectionFailed(error instanceof Error ? error.message : '无法读取语音状态'));
  },

  async cancelSpeechGeneration(audioId) {
    const request = [...generationRequests.values()]
      .find(generation => generation.audioId === audioId);
    if (!request) {
      // 页面重开后也可以取消列表里已有的 generating 记录, 不要求一定持有原 HTTP 请求.
      try {
        await audioApi.cancelGeneration(audioId);
        refreshObservedTurns();
      } catch (error) {
        showToast(error instanceof Error ? error.message : '取消语音生成失败', { variant: 'danger' });
      }
      return;
    }
    const generationKey = audioGenerationKey(request.input.turnId, request.input.characterName);
    const previous = get().generationsByTurnAndCharacter.get(generationKey);
    if (previous?.generationStatus === 'cancelling') return;
    saveGeneration(request, 'cancelling');
    try {
      await audioApi.cancelGeneration(audioId);
    } catch (error) {
      if (ownsRequest(request)) saveGeneration(request, 'generating');
      showToast(error instanceof Error ? error.message : '取消语音生成失败', { variant: 'danger' });
    }
  },

  deleteAudio(input) {
    const { audioId } = input;
    const existing = get().deletionRequests.get(audioId);
    if (existing) return existing.deletionCompletion;
    const isCurrentDeletion = (): boolean => get().deletionRequests.get(audioId) === deletionRequest;
    // HTTP 推迟到登记后执行, 界面和 Playback 的同步订阅此时也能查到同一次删除.
    const deletionCompletion: Promise<void> = Promise.resolve().then(async () => {
      if (!isCurrentDeletion()) return;
      const audioTurnId = deletionRequest.turnId;
      try {
        await audioApi.deleteAudio(audioId);
        // Session 已清理时只结束原 HTTP 请求, 不恢复列表或显示迟到的删除结果.
        if (!isCurrentDeletion()) return;
        invalidateTurnRead(audioTurnId);
        const turn = get().turnAudioByTurnId.get(audioTurnId);
        if (turn?.audioRecords) {
          const audioRecords = turn.audioRecords.filter(audio => audio.audioId !== audioId);
          const turnAudioByTurnId = new Map(get().turnAudioByTurnId);
          turnAudioByTurnId.set(audioTurnId, { ...turn, audioRecords });
          set({ turnAudioByTurnId });
        }
      } catch (error) {
        if (isCurrentDeletion()) {
          showToast(error instanceof Error ? error.message : '音频删除失败', { variant: 'danger' });
        }
      } finally {
        if (isCurrentDeletion()) {
          // deleted 通知可能先于 HTTP 回来, 最后重读才能结束被撤销的列表刷新.
          await get().refreshTurnAudio(audioTurnId);
          // 刷新期间也可能删除 Session, 不能再改动已经移除或被替换的登记.
          if (isCurrentDeletion()) {
            const deletionRequests = new Map(get().deletionRequests);
            deletionRequests.delete(audioId);
            set({ deletionRequests });
          }
        }
      }
    });
    const deletionRequest: AudioDeletionRequest = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      deletionCompletion,
    };
    const deletionRequests = new Map(get().deletionRequests);
    deletionRequests.set(audioId, deletionRequest);
    set({ deletionRequests });
    invalidateTurnRead(deletionRequest.turnId);
    return deletionCompletion;
  },

  /** Session 删除或归档后, 释放本窗口的音频状态. */
  clearSessionAudio(sessionId) {
    // 归档和删除都会清理前端状态, 这里不能调用 deleteAudio, 否则归档也会删除已保存录音.
    for (const request of [...generationRequests.values()]) {
      if (request.input.sessionId === sessionId) finishRequest(request);
    }
    const current = get();
    const turnAudioByTurnId = new Map(current.turnAudioByTurnId);
    for (const [turnId, turn] of turnAudioByTurnId) {
      if (turn.sessionId !== sessionId) continue;
      invalidateTurnRead(turnId);
      turnReaders.delete(turnId);
      turnAudioByTurnId.delete(turnId);
    }
    const deletionRequests = new Map(current.deletionRequests);
    for (const [audioId, request] of deletionRequests) {
      if (request.sessionId === sessionId) deletionRequests.delete(audioId);
    }
    if (turnAudioByTurnId.size === current.turnAudioByTurnId.size
      && deletionRequests.size === current.deletionRequests.size) return;
    set({ turnAudioByTurnId, deletionRequests });
  },
}));

export function receiveAudioSystemEvent(event: AppEvent): void {
  const store = useAudioStore.getState();
  if (event.type === 'sessions_deleted') {
    for (const sessionId of event.sessionIds) store.clearSessionAudio(sessionId);
  } else if (event.type === 'session_audio_changed') {
    const audioStatus = event.audioStatus;
    const request = generationRequests.get(audioGenerationKey(event.turnId, event.characterName));
    if (event.audioStatus === 'generating' && request && request.audioId === null) {
      request.audioId = event.audioId;
      saveGeneration(request, 'generating');
    }
    // 删除通知先让旧读取失效并移除条目, 不等 HTTP 回来才禁用旧列表.
    invalidateTurnRead(event.turnId);
    if (audioStatus !== 'deleted') {
      const turn = store.turnAudioByTurnId.get(event.turnId);
      if (turn?.audioRecords) {
        const audioRecords = turn.audioRecords.map(audio => audio.audioId === event.audioId
          ? { ...audio, audioStatus }
          : audio);
        useAudioStore.setState({ turnAudioByTurnId: new Map(store.turnAudioByTurnId).set(event.turnId, { ...turn, audioRecords }) });
      }
    } else {
      const turn = store.turnAudioByTurnId.get(event.turnId);
      if (turn?.audioRecords) {
        const audioRecords = turn.audioRecords.filter(audio => audio.audioId !== event.audioId);
        useAudioStore.setState({ turnAudioByTurnId: new Map(store.turnAudioByTurnId).set(event.turnId, { ...turn, audioRecords }) });
      }
    }
    void useAudioStore.getState().refreshTurnAudio(event.turnId);
  } else if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_aborted') {
    void store.refreshTurnAudio(event.turnId);
  }
}

/** 菜单关闭或页面隐藏时解除使用, 最后一个使用者离开后释放这一轮的列表. */
export function useTurnAudio(sessionId: string, turnId: string, shouldRead: boolean): TurnAudioState | undefined {
  useEffect(() => {
    if (!shouldRead) return undefined;
    return useAudioStore.getState().observeTurnAudio(sessionId, turnId);
  }, [sessionId, turnId, shouldRead]);
  return useAudioStore(state => state.turnAudioByTurnId.get(turnId));
}
