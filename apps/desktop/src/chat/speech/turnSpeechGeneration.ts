import { create } from 'zustand';
import type { SpeechGenerateEvent } from '@ema-agent/server/routes/ws/speech.js';
import { openSpeechSocket, type SpeechSocketHandle } from '../../api/speechWebSocket.js';
import { turnsApi } from '../../api/turns.js';
import { showToast } from '../../lib/notifications/toast.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';

interface TurnSpeechGeneration {
  readonly sessionId: string;
  readonly turnId: string;
  readonly audioReady: boolean;
  readonly cancelling: boolean;
}

interface GenerationState {
  readonly active: ReadonlyMap<string, TurnSpeechGeneration>;
}

export const useSpeechGenerationStore = create<GenerationState>(() => ({ active: new Map() }));

interface SpeechObservation {
  readonly sessionId: string;
  readonly turnId: string;
  socket: SpeechSocketHandle | null;
}

const observations = new Map<string, SpeechObservation>();
const listeners = new Set<(event: SpeechGenerateEvent) => void>();

export function subscribeSpeechGeneration(listener: (event: SpeechGenerateEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setGeneration(generation: TurnSpeechGeneration): void {
  const active = new Map(useSpeechGenerationStore.getState().active);
  active.set(generation.turnId, generation);
  useSpeechGenerationStore.setState({ active });
}

function forgetGeneration(turnId: string): void {
  const active = new Map(useSpeechGenerationStore.getState().active);
  active.delete(turnId);
  useSpeechGenerationStore.setState({ active });
}

function finishObservation(observation: SpeechObservation): void {
  if (observations.get(observation.turnId) !== observation) return;
  observations.delete(observation.turnId);
  observation.socket?.close();
  forgetGeneration(observation.turnId);
}

function receiveControl(observation: SpeechObservation, event: SpeechGenerateEvent): void {
  if (observations.get(observation.turnId) !== observation) return;
  if (event.type === 'speech_generate_started') {
    const current = useSpeechGenerationStore.getState().active.get(event.turnId);
    if (current) setGeneration({ ...current, audioReady: true });
  } else if (event.type === 'speech_generate_warning') {
    showToast(`语音合成失败: ${event.message}`, { variant: 'warning' });
  } else {
    finishObservation(observation);
    if (event.type === 'speech_generate_failed') {
      showToast(`语音生成失败: ${event.message}`, { variant: 'warning' });
    }
  }
  for (const listener of listeners) listener(event);
}

/** 每个 Turn 只有一份生成订阅; 没有播放 owner 的 Session 也能显示生成与取消入口. */
export function observeTurnSpeechGeneration(sessionId: string, turnId: string): void {
  if (useSpeechGenerationStore.getState().active.has(turnId)) return;
  const observation: SpeechObservation = { sessionId, turnId, socket: null };
  observations.set(turnId, observation);
  setGeneration({ sessionId, turnId, audioReady: false, cancelling: false });
  void openSpeechSocket(sessionId, turnId, {
    onControl: event => receiveControl(observation, event),
    onClosed: () => {
      if (observations.get(turnId) !== observation) return;
      finishObservation(observation);
      for (const listener of listeners) listener({ type: 'speech_generate_unavailable', sessionId, turnId });
      showToast('语音状态连接已断开, 后台生成未被取消', { variant: 'warning' });
    },
  }).then(socket => {
    if (observations.get(turnId) === observation) observation.socket = socket;
    else socket.close();
  }).catch(error => {
    if (observations.get(turnId) !== observation) return;
    finishObservation(observation);
    for (const listener of listeners) listener({ type: 'speech_generate_unavailable', sessionId, turnId });
    showToast(error instanceof Error ? error.message : '无法读取语音生成状态', { variant: 'warning' });
  });
}

/** 请求由共享模块持有, Footer 卸载不会取消生成, 完成后只刷新事实和通知. */
export async function generateTurnSpeech(
  sessionId: string,
  turnId: string,
  characterName?: string,
): Promise<void> {
  if (useSpeechGenerationStore.getState().active.has(turnId)) return;
  const generation: TurnSpeechGeneration = { sessionId, turnId, audioReady: false, cancelling: false };
  setGeneration(generation);
  try {
    const result = await turnsApi.generateSpeech(turnId, characterName);
    if (!useSpeechGenerationStore.getState().active.has(turnId)) return;
    if (result.status === 'completed') showToast('该轮语音已生成, 点击播放即可收听');
    else if (result.status === 'cancelled') showToast('已取消语音生成, 原有音频未被替换', { variant: 'info' });
    else showToast(`语音生成失败: ${result.message}`, { variant: 'warning' });
    await useSessionHistoryStore.getState().mergeTurnMessages(sessionId, turnId);
  } catch (error) {
    if (useSpeechGenerationStore.getState().active.has(turnId)) {
      showToast(error instanceof Error ? error.message : '语音生成失败', { variant: 'warning' });
    }
  } finally {
    forgetGeneration(turnId);
  }
}

export async function cancelTurnSpeechGeneration(turnId: string): Promise<void> {
  const current = useSpeechGenerationStore.getState().active.get(turnId);
  if (!current || current.cancelling) return;
  setGeneration({ ...current, cancelling: true });
  try {
    await turnsApi.cancelSpeech(turnId);
  } catch (error) {
    if (useSpeechGenerationStore.getState().active.has(turnId)) setGeneration({ ...current, cancelling: false });
    showToast(error instanceof Error ? error.message : '取消语音生成失败', { variant: 'warning' });
  }
}

/** Server 已取消相关任务后, 不让晚到的连接或结果继续影响被删除的 Session. */
export function removeSessionSpeechGeneration(sessionId: string): void {
  for (const observation of observations.values()) {
    if (observation.sessionId === sessionId) finishObservation(observation);
  }
  for (const generation of useSpeechGenerationStore.getState().active.values()) {
    if (generation.sessionId === sessionId) forgetGeneration(generation.turnId);
  }
}
