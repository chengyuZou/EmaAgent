import { useEffect } from 'react';
import { create } from 'zustand';
import { providersApi } from '../../../api/providers.js';
import { useMainNavigationStore } from '../../../layout/navigation.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { useProviderStore } from '../../../stores/provider.js';
import { editChatDraft } from '../editChatDraft.js';

export type VoiceInputState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'recording'; readonly stream: MediaStream }
  | { readonly kind: 'transcribing' };

interface VoiceInputStore {
  // null belongs to the new-conversation draft before a Session is created.
  readonly bySession: ReadonlyMap<string | null, VoiceInputState>;
}

interface VoiceRecording {
  sessionId: string | null;
  readonly abort: AbortController;
  media: MediaStream | null;
  recorder: MediaRecorder | null;
  unsubscribeNavigation: (() => void) | null;
}

const idle: VoiceInputState = { kind: 'idle' };
const useVoiceInputStore = create<VoiceInputStore>(() => ({ bySession: new Map() }));
const recordings = new Map<string | null, VoiceRecording>();

export function useVoiceInput(sessionId: string | null): VoiceInputState {
  const state = useVoiceInputStore(store => store.bySession.get(sessionId) ?? idle);
  // Replacing the new/existing conversation page also unmounts ChatInput.
  // Stop its microphone, but keep transcription and its draft owner outside the component.
  useEffect(() => () => stopVoiceInput(sessionId), [sessionId]);
  return state;
}

function setVoiceInput(recording: VoiceRecording, state: VoiceInputState): void {
  const bySession = new Map(useVoiceInputStore.getState().bySession);
  bySession.set(recording.sessionId, state);
  useVoiceInputStore.setState({ bySession });
}

function releaseMicrophone(recording: VoiceRecording): void {
  recording.media?.getTracks().forEach(track => track.stop());
  recording.media = null;
}

function finishVoiceInput(recording: VoiceRecording): void {
  if (recordings.get(recording.sessionId) !== recording) return;
  recordings.delete(recording.sessionId);
  recording.unsubscribeNavigation?.();
  releaseMicrophone(recording);
  const bySession = new Map(useVoiceInputStore.getState().bySession);
  bySession.delete(recording.sessionId);
  useVoiceInputStore.setState({ bySession });
}

export function cancelVoiceInput(sessionId: string | null): void {
  const recording = recordings.get(sessionId);
  if (!recording) return;
  // Forget the operation before abort/stop callbacks can submit audio or append late text.
  finishVoiceInput(recording);
  recording.abort.abort();
  if (recording.recorder?.state === 'recording') recording.recorder.stop();
}

export function stopVoiceInput(sessionId: string | null): void {
  const recording = recordings.get(sessionId);
  if (!recording) return;
  if (!recording.recorder) {
    // A pending permission prompt has not produced audio. Close any stream that arrives later.
    cancelVoiceInput(sessionId);
    return;
  }
  if (recording.recorder.state !== 'recording') return;
  setVoiceInput(recording, { kind: 'transcribing' });
  recording.recorder.stop();
  // Native stop events are queued. Release the microphone now, not when those events arrive.
  releaseMicrophone(recording);
}

async function transcribeRecording(recording: VoiceRecording, audio: Blob): Promise<void> {
  if (!useProviderStore.getState().bindings.stt) {
    showToast('STT 模型已解绑, 本次录音未转写', { variant: 'warning' });
    finishVoiceInput(recording);
    return;
  }
  try {
    const result = await providersApi.transcribe({ audio, mime: audio.type }, recording.abort.signal);
    if (recordings.get(recording.sessionId) !== recording) return;
    // Read the latest draft only after transcription returns. Deletion must not recreate a draft.
    editChatDraft(recording.sessionId, current => ({
      ...current,
      text: `${current.text}${result.text.trim()}`,
    }));
  } catch (error) {
    if (recordings.get(recording.sessionId) !== recording) return;
    showToast(error instanceof Error ? error.message : '语音转写失败', { variant: 'danger' });
  } finally {
    finishVoiceInput(recording);
  }
}

export async function startVoiceInput(sessionId: string | null): Promise<void> {
  if (recordings.has(sessionId)) return;
  if (!useProviderStore.getState().bindings.stt) {
    showToast('请先配置 STT 模型绑定', { variant: 'warning' });
    return;
  }
  const recording: VoiceRecording = {
    sessionId,
    abort: new AbortController(),
    media: null,
    recorder: null,
    unsubscribeNavigation: null,
  };
  recordings.set(sessionId, recording);
  setVoiceInput(recording, { kind: 'starting' });
  recording.unsubscribeNavigation = useMainNavigationStore.subscribe((navigation, previous) => {
    if (navigation.viewedSessionId !== previous.viewedSessionId
      && navigation.viewedSessionId !== recording.sessionId) {
      stopVoiceInput(recording.sessionId);
    }
  });
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (recordings.get(recording.sessionId) !== recording) {
      media.getTracks().forEach(track => track.stop());
      return;
    }
    recording.media = media;
    const recorder = new MediaRecorder(media);
    recording.recorder = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => {
      if (recordings.get(recording.sessionId) === recording && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      releaseMicrophone(recording);
      if (recordings.get(recording.sessionId) !== recording) return;
      setVoiceInput(recording, { kind: 'transcribing' });
      const audio = new Blob(chunks, { type: recorder.mimeType });
      chunks.length = 0;
      void transcribeRecording(recording, audio);
    };
    recorder.start();
    setVoiceInput(recording, { kind: 'recording', stream: media });
  } catch (error) {
    if (recordings.get(recording.sessionId) !== recording) return;
    cancelVoiceInput(recording.sessionId);
    showToast(error instanceof Error ? error.message : '无法使用麦克风', { variant: 'danger' });
  }
}

/** Move pending dictation with the new draft when its first submission creates a Session. */
export function promoteNewSessionVoiceInput(sessionId: string): void {
  const recording = recordings.get(null);
  if (!recording) return;
  recordings.delete(null);
  recording.sessionId = sessionId;
  recordings.set(sessionId, recording);
  const bySession = new Map(useVoiceInputStore.getState().bySession);
  const state = bySession.get(null)!;
  bySession.delete(null);
  bySession.set(sessionId, state);
  useVoiceInputStore.setState({ bySession });
}
