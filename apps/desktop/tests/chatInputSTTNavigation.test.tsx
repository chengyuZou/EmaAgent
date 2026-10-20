// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { ChatInput } from '../src/chat/input/ChatInput.js';
import { cancelVoiceInput, promoteNewSessionVoiceInput } from '../src/chat/input/voiceInput.js';
import { removeSessionFromChat } from '../src/chat/session/removeSessionFromChat.js';
import { MainView, useMainNavigationStore } from '../src/layout/navigation.js';
import { emptyChatDraft, useChatDraftStore } from '../src/stores/chatDraft.js';
import { useProviderStore } from '../src/stores/provider.js';
import { useSessionStore } from '../src/stores/session.js';
import type { SessionListItem } from '../src/api/sessions.js';

const api = vi.hoisted(() => ({
  transcribe: vi.fn(),
  getUserMedia: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/api/providers.js', () => ({ providersApi: { transcribe: api.transcribe } }));
vi.mock('../src/lib/notifications/toast.js', () => ({
  showToast: api.toast,
  runWithToast: (operation: Promise<unknown>) => operation,
}));
vi.mock('../src/chat/sidePanel/tabs/terminal/terminalSessions.js', () => ({
  closeSessionTerminals: async () => {},
}));
vi.mock('../src/chat/interactions/PendingInteractionView.js', () => ({ PendingInteractionView: () => null }));
vi.mock('../src/chat/input/controls/ContextMeter.js', () => ({ ContextMeter: () => null }));
vi.mock('../src/chat/input/inputProjectBar.js', () => ({ InputProjectBar: () => null }));
vi.mock('../src/chat/input/narrativeToolNotice.js', () => ({ NarrativeToolNotice: () => null }));
vi.mock('../src/chat/input/controls/InputSelectors.js', () => ({
  PermissionModeSelector: () => null,
  TTSButton: () => null,
  useInputOptions: () => ({ plusItems: [] }),
}));
vi.mock('../src/chat/input/controls/ModelPicker.js', () => ({
  ModelPicker: () => null,
  useInputModel: () => ({ catalog: { status: 'ready' }, shownModelEdit: null }),
}));
vi.mock('../src/chat/input/controls/goalBar.js', () => ({
  InputGoalBar: () => null,
  useInputGoal: () => ({ creatingGoal: false, goalAvailable: false }),
}));
vi.mock('../src/chat/input/draftAttachments.js', () => ({
  DraftReferenceList: () => null,
  useDraftAttachments: () => ({}),
}));
vi.mock('../src/chat/input/AddInputMenu.js', () => ({
  SlashCommandMenu: () => null,
  activeSlashToken: () => null,
  useInputCommands: () => ({ compacting: false, commandDialogs: null }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class TestMediaRecorder {
  static instances: TestMediaRecorder[] = [];
  state: RecordingState = 'inactive';
  readonly mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(readonly stream: MediaStream) {
    TestMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => { this.state = 'inactive'; });

  // Native stop queues dataavailable and stop events after the calling code returns.
  deliverAudio(): void {
    this.ondataavailable?.({ data: new Blob(['recorded audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function microphone() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  return { stream, stop };
}

function session(id: string): SessionListItem {
  return {
    id, title: id, cwd: 'C:/fixture', projectId: null,
    createdAt: 1, updatedAt: 1, lastActivityAt: 1, archivedAt: null, pinned: false,
    forkedFromSessionId: null, forkedFromTurnId: null, permissionMode: 'default',
    ttsEnabled: false, providerId: null, modelId: null, reasoningEffort: 'off',
    lastViewedAt: null, hasActiveTurn: false, lastTurnStatus: null, hasUnread: false,
  };
}

let host: HTMLDivElement;
let root: Root;

async function click(label: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

async function viewSession(sessionId: string): Promise<void> {
  await act(async () => useMainNavigationStore.getState().viewSession(sessionId));
}

function expectVoiceActive(active: boolean): void {
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-active')).toBe(String(active));
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('MediaRecorder', TestMediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: api.getUserMedia } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  TestMediaRecorder.instances = [];
  useMainNavigationStore.setState(useMainNavigationStore.getInitialState());
  useChatDraftStore.setState({ bySession: new Map(), newSessionDraft: emptyChatDraft() });
  useProviderStore.setState({ bindings: {
    stt: { module: 'stt', capability: 'stt', providerId: 'fixture', modelId: 'fixture' },
  } });
  useSessionStore.setState({ sessions: {
    pinned: [], pinnedProjects: [], projects: [], recent: [],
    byId: new Map(['a', 'b'].map(id => [id, session(id)])),
  } });
  useMainNavigationStore.getState().viewSession('a');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <TooltipProvider><ChatInput onSubmit={async () => {}} /></TooltipProvider>,
  ));
});

afterEach(async () => {
  await act(async () => {
    for (const sessionId of ['a', 'b', null]) cancelVoiceInput(sessionId);
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('stops A immediately on navigation and transcribes into A latest draft without carrying its UI into B', async () => {
  const audio = microphone();
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(audio.stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  const recorder = TestMediaRecorder.instances[0]!;
  expect(recorder.state).toBe('recording');
  expectVoiceActive(true);

  await act(async () => {
    useMainNavigationStore.getState().viewSession('b');
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalled();
  });
  expectVoiceActive(false);

  await act(async () => recorder.deliverAudio());
  expect(api.transcribe).toHaveBeenCalledOnce();
  expect(api.transcribe.mock.calls[0]![1].aborted).toBe(false);
  await act(async () => {
    useChatDraftStore.getState().setForSession('a', { ...emptyChatDraft(), text: 'New A draft: ' });
    useChatDraftStore.getState().setForSession('b', { ...emptyChatDraft(), text: 'B draft' });
    result.resolve({ text: ' transcription ' });
  });
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('New A draft: transcription');
  expect(useChatDraftStore.getState().bySession.get('b')?.text).toBe('B draft');
  expectVoiceActive(false);
});

it('manual stop already appends transcription to the latest draft', async () => {
  const audio = microphone();
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(audio.stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await click('停止录音并转写');
  const recorder = TestMediaRecorder.instances[0]!;
  expect(recorder.stop).toHaveBeenCalledOnce();
  await act(async () => recorder.deliverAudio());
  expect(api.transcribe).toHaveBeenCalledOnce();
  await act(async () => {
    useChatDraftStore.getState().setForSession('a', { ...emptyChatDraft(), text: 'Latest: ' });
    result.resolve({ text: ' words ' });
  });
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('Latest: words');
  expectVoiceActive(false);
});

it('does not let A pending transcription occupy B voice controls', async () => {
  const audioA = microphone();
  const audioB = microphone();
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(audioA.stream).mockResolvedValueOnce(audioB.stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await click('停止录音并转写');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await viewSession('b');
  expectVoiceActive(false);
  await click('语音输入');
  expect(api.getUserMedia).toHaveBeenCalledTimes(2);
  expect(TestMediaRecorder.instances[1]!.state).toBe('recording');
  await act(async () => result.resolve({ text: 'A result' }));
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('A result');
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-recording')).toBe('true');
});

it('keeps two pending transcriptions independent when returning to their Sessions', async () => {
  const resultA = deferred<{ text: string }>();
  const resultB = deferred<{ text: string }>();
  api.getUserMedia
    .mockResolvedValueOnce(microphone().stream)
    .mockResolvedValueOnce(microphone().stream);
  api.transcribe.mockReturnValueOnce(resultA.promise).mockReturnValueOnce(resultB.promise);
  await click('语音输入');
  await viewSession('b');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await click('语音输入');
  await viewSession('a');
  await act(async () => TestMediaRecorder.instances[1]!.deliverAudio());
  expect(host.textContent).toContain('正在转写');
  await click('语音输入');
  expect(api.getUserMedia).toHaveBeenCalledTimes(2);

  await act(async () => resultB.resolve({ text: 'B result' }));
  expect(host.textContent).toContain('正在转写');
  expectVoiceActive(true);
  expect(useChatDraftStore.getState().bySession.get('b')?.text).toBe('B result');
  await act(async () => resultA.resolve({ text: 'A result' }));
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('A result');
  expectVoiceActive(false);
  await viewSession('b');
  expectVoiceActive(false);
});

it('closes a late microphone stream after switching while permission is pending', async () => {
  const audioA = microphone();
  const permission = deferred<MediaStream>();
  api.getUserMedia.mockReturnValueOnce(permission.promise).mockResolvedValueOnce(microphone().stream);
  await click('语音输入');
  expect(host.textContent).toContain('正在开启麦克风');
  await viewSession('b');
  expectVoiceActive(false);
  await click('语音输入');
  await act(async () => permission.resolve(audioA.stream));
  expect(audioA.stop).toHaveBeenCalledOnce();
  expect(TestMediaRecorder.instances).toHaveLength(1);
  expect(TestMediaRecorder.instances[0]!.state).toBe('recording');
  expect(api.transcribe).not.toHaveBeenCalled();
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-recording')).toBe('true');
});

it('keeps A transcription through a composer remount on the new-conversation page', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await act(async () => {
    useMainNavigationStore.getState().openNewSession();
    root.render(
      <TooltipProvider><ChatInput key="new-conversation" onSubmit={async () => {}} /></TooltipProvider>,
    );
  });
  expectVoiceActive(false);
  const recorder = TestMediaRecorder.instances[0]!;
  expect(recorder.stop).toHaveBeenCalledOnce();
  await act(async () => recorder.deliverAudio());
  await act(async () => result.resolve({ text: 'Original session' }));
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('Original session');
  expect(useChatDraftStore.getState().newSessionDraft.text).toBe('');
  expectVoiceActive(false);
});

it('keeps new-conversation dictation with its draft when the first submission creates a Session', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await act(async () => useMainNavigationStore.getState().openNewSession());
  await click('语音输入');
  await click('停止录音并转写');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await act(async () => {
    useChatDraftStore.getState().setForNewSession({ ...emptyChatDraft(), text: 'Later typing: ' });
    useChatDraftStore.getState().promoteNewSession('a');
    promoteNewSessionVoiceInput('a');
    useMainNavigationStore.getState().promoteNewSession('a');
    root.render(
      <TooltipProvider><ChatInput key="existing-conversation" onSubmit={async () => {}} /></TooltipProvider>,
    );
  });
  expectVoiceActive(true);
  await act(async () => result.resolve({ text: 'dictation' }));
  expect(useChatDraftStore.getState().bySession.get('a')?.text).toBe('Later typing: dictation');
  expect(useChatDraftStore.getState().newSessionDraft.text).toBe('');
  expectVoiceActive(false);
});

it('discards cancelled audio without transcribing it', async () => {
  const audio = microphone();
  api.getUserMedia.mockResolvedValueOnce(audio.stream);
  await click('语音输入');
  await click('取消录音');
  expectVoiceActive(false);
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(TestMediaRecorder.instances[0]!.stop).toHaveBeenCalledOnce();
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  expect(api.transcribe).not.toHaveBeenCalled();
});

it('ignores a cancelled transcription even after a new recording starts in the same Session', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValue(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await click('停止录音并转写');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  const signal = api.transcribe.mock.calls[0]![1] as AbortSignal;
  await click('取消转写');
  expect(signal.aborted).toBe(true);
  await click('语音输入');
  await act(async () => result.resolve({ text: 'Cancelled words' }));
  expect(useChatDraftStore.getState().bySession.has('a')).toBe(false);
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-recording')).toBe('true');
  expect(api.toast).not.toHaveBeenCalled();
});

it('does not restore a draft when its Session disappears before transcription returns', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await viewSession('b');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await act(async () => {
    const sessions = useSessionStore.getState().sessions;
    const byId = new Map(sessions.byId);
    byId.delete('a');
    useSessionStore.setState({ sessions: { ...sessions, byId } });
    result.resolve({ text: 'Removed session' });
  });
  expect(useChatDraftStore.getState().bySession.has('a')).toBe(false);
  expectVoiceActive(false);
});

it('reports transcription failure without clearing another Session recording', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValue(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await viewSession('b');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await click('语音输入');
  await act(async () => result.reject(new Error('STT unavailable')));
  expect(api.toast).toHaveBeenCalledWith('STT unavailable', { variant: 'danger' });
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-recording')).toBe('true');
});

it('releases the microphone and resets its owner when recorder construction fails', async () => {
  const audio = microphone();
  api.getUserMedia.mockResolvedValueOnce(audio.stream);
  vi.stubGlobal('MediaRecorder', class {
    constructor() { throw new Error('Recording unsupported'); }
  });
  await click('语音输入');
  expectVoiceActive(false);
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(api.toast).toHaveBeenCalledWith('Recording unsupported', { variant: 'danger' });
});

it('rechecks the STT binding before submitting stopped audio', async () => {
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  await click('语音输入');
  await act(async () => useProviderStore.setState({ bindings: {} }));
  await viewSession('b');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  expect(api.transcribe).not.toHaveBeenCalled();
  expect(api.toast).toHaveBeenCalledWith('STT 模型已解绑, 本次录音未转写', { variant: 'warning' });
  await viewSession('a');
  expectVoiceActive(false);
});

it('cancels transcription through Session removal without touching B recording', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValue(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await click('语音输入');
  await viewSession('b');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  const signal = api.transcribe.mock.calls[0]![1] as AbortSignal;
  await click('语音输入');
  await act(async () => removeSessionFromChat('a'));
  expect(signal.aborted).toBe(true);
  await act(async () => result.resolve({ text: 'Removed session' }));
  expect(useChatDraftStore.getState().bySession.has('a')).toBe(false);
  expect(host.querySelector('.ema-voice-input-bar')?.getAttribute('data-recording')).toBe('true');
  expect(api.toast).not.toHaveBeenCalled();
});

it('keeps recording when opening Settings without changing the selected Session', async () => {
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  await click('语音输入');
  await act(async () => useMainNavigationStore.getState().setActiveView(MainView.Settings));
  expect(TestMediaRecorder.instances[0]!.stop).not.toHaveBeenCalled();
  expectVoiceActive(true);
  await act(async () => useMainNavigationStore.getState().goBack());
  expect(TestMediaRecorder.instances[0]!.stop).not.toHaveBeenCalled();
});

it('stops recording when history navigation selects a different Session', async () => {
  await viewSession('b');
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  await click('语音输入');
  await act(async () => useMainNavigationStore.getState().goBack());
  expect(useMainNavigationStore.getState().viewedSessionId).toBe('a');
  expect(TestMediaRecorder.instances[0]!.stop).toHaveBeenCalledOnce();
  expectVoiceActive(false);
});

it('leaves new-conversation transcription in the new draft after switching to an existing Session', async () => {
  const result = deferred<{ text: string }>();
  api.getUserMedia.mockResolvedValueOnce(microphone().stream);
  api.transcribe.mockReturnValueOnce(result.promise);
  await act(async () => useMainNavigationStore.getState().openNewSession());
  await click('语音输入');
  await viewSession('a');
  await act(async () => TestMediaRecorder.instances[0]!.deliverAudio());
  await act(async () => result.resolve({ text: 'New draft text' }));
  expect(useChatDraftStore.getState().newSessionDraft.text).toBe('New draft text');
  expect(useChatDraftStore.getState().bySession.has('a')).toBe(false);
  expectVoiceActive(false);
});
