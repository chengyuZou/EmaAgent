// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StageVoiceInput } from '../src/stage/voiceInput/StageVoiceInput.js';
import type { StageVoiceContextChange, StageVoiceSendResult } from '../src/lib/tauri/types.js';

const mock = vi.hoisted(() => ({
  listenContext: vi.fn(), listenSendResult: vi.fn(), sendDraft: vi.fn(),
  createDetector: vi.fn(), transcribe: vi.fn(), stopTrack: vi.fn(), destroyDetector: vi.fn(),
  getTrackSettings: vi.fn(),
}));

vi.mock('@ema-agent/ui', () => ({
  IconButton: ({ label, disabled, onClick }: {
    label: string; disabled?: boolean; onClick(): void;
  }) => <button aria-label={label} disabled={disabled} onClick={onClick} />,
  Textarea: ({ value, onChange, disabled }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea value={value} onChange={onChange} disabled={disabled} />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: mock.createDetector }, utils: { encodeWAV: () => new ArrayBuffer(44) },
}));
vi.mock('../src/api/providers.js', () => ({ providersApi: { transcribe: mock.transcribe } }));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../src/lib/tauri/tauriBridge.js', () => ({ tauriBridge: {
  isTauri: () => true,
  listenStageVoiceContext: mock.listenContext,
  listenStageVoiceSendResult: mock.listenSendResult,
  requestStageVoiceContext: async () => {},
  sendStageVoiceDraft: mock.sendDraft,
} }));

const sessions = [
  { sessionId: 'code', title: '代码排查' },
  { sessionId: 'chat', title: '日常聊天' },
];
let host: HTMLDivElement;
let root: Root;
let receiveContext: (event: StageVoiceContextChange) => void;
let receiveSendResult: (result: StageVoiceSendResult) => void;
let detectorCallbacks: { onSpeechStart(): void; onSpeechEnd(samples: Float32Array): void };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const microphoneTrack = { stop: mock.stopTrack, getSettings: mock.getTrackSettings };
  mock.getTrackSettings.mockReturnValue({});
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [microphoneTrack],
        getAudioTracks: () => [microphoneTrack],
      }),
    },
  });
  vi.stubGlobal('AudioContext', class { async close() {} });
  mock.listenContext.mockImplementation(async callback => {
    receiveContext = callback;
    return () => {};
  });
  mock.listenSendResult.mockImplementation(async callback => {
    receiveSendResult = callback;
    return () => {};
  });
  mock.sendDraft.mockResolvedValue(undefined);
  mock.destroyDetector.mockResolvedValue(undefined);
  mock.createDetector.mockImplementation(async callbacks => {
    detectorCallbacks = callbacks;
    return { destroy: mock.destroyDetector };
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function click(label: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
  await act(async () => button.click());
}

async function selectSession(sessionId: string): Promise<void> {
  await act(async () => receiveContext({ type: 'viewed-session', sessionId }));
}

function draftText(): string {
  return host.querySelector('textarea')!.value;
}

async function startVoiceInput(): Promise<void> {
  await act(async () => root.render(<StageVoiceInput suspended={false} />));
  await act(async () => receiveContext({ type: 'sessions', sessions }));
  await selectSession('code');
  await click('展开麦克风面板');
  expect(mock.createDetector).not.toHaveBeenCalled();
  await click('开启监听');
}

async function recordSegment(): Promise<void> {
  await act(async () => {
    detectorCallbacks.onSpeechStart();
    detectorCallbacks.onSpeechEnd(new Float32Array(512));
  });
}

it.each([
  { echoCancellation: true, shouldTranscribe: true },
  { echoCancellation: false, shouldTranscribe: false },
  { echoCancellation: undefined, shouldTranscribe: false },
])('角色播放时按音轨的实际回声消除设置接收录音 ($echoCancellation)', async ({ echoCancellation, shouldTranscribe }) => {
  mock.getTrackSettings.mockReturnValue({ echoCancellation });
  mock.transcribe.mockResolvedValue({ text: '等一下' });
  await startVoiceInput();
  await act(async () => receiveContext({ type: 'playback', isPlaying: true }));
  await recordSegment();
  expect(mock.transcribe).toHaveBeenCalledTimes(shouldTranscribe ? 1 : 0);
  expect(draftText()).toBe(shouldTranscribe ? '等一下' : '');
});

it('录音开始时绑定会话, X 清空后晚到的转写仍追加到原会话', async () => {
  mock.transcribe.mockResolvedValueOnce({ text: '旧草稿' });
  let finishTranscription!: (result: { text: string }) => void;
  mock.transcribe.mockImplementationOnce(() => new Promise(resolve => { finishTranscription = resolve; }));
  await startVoiceInput();
  await recordSegment();
  expect(draftText()).toBe('旧草稿');

  await act(async () => detectorCallbacks.onSpeechStart());
  await selectSession('chat');
  await act(async () => detectorCallbacks.onSpeechEnd(new Float32Array(512)));
  expect(draftText()).toBe('');
  await selectSession('code');
  await click('丢弃文字');
  expect(mock.transcribe.mock.calls[1]![1].aborted).toBe(false);
  await act(async () => finishTranscription({ text: '晚到的文字' }));
  expect(draftText()).toBe('晚到的文字');
});

it('归档取消正在转写的请求, 同一 ID 回来后旧结果仍作废', async () => {
  mock.transcribe.mockResolvedValueOnce({ text: '归档前的草稿' });
  let finishTranscription!: (result: { text: string }) => void;
  mock.transcribe.mockImplementationOnce(() => new Promise(resolve => { finishTranscription = resolve; }));
  await startVoiceInput();
  await recordSegment();
  await recordSegment();
  await act(async () => {
    receiveContext({ type: 'sessions', sessions: [sessions[1]!] });
    receiveContext({ type: 'sessions', sessions });
    finishTranscription({ text: '旧结果' });
  });
  expect(mock.transcribe.mock.calls[1]![1].aborted).toBe(true);
  expect(draftText()).toBe('');
});

it('提交回执保留发送后新到的文字, 隐藏 Stage 释放麦克风', async () => {
  mock.transcribe.mockResolvedValueOnce({ text: '先发这一段' }).mockResolvedValueOnce({ text: '下一段' });
  await startVoiceInput();
  await recordSegment();
  await click('发送');
  const request = mock.sendDraft.mock.calls[0]![0];
  expect(request).toMatchObject({ sessionId: 'code', text: '先发这一段' });
  await recordSegment();
  await act(async () => receiveSendResult({ requestId: request.requestId, status: 'accepted' }));
  expect(draftText()).toBe('下一段');
  await act(async () => root.render(<StageVoiceInput suspended />));
  expect(mock.stopTrack).toHaveBeenCalledOnce();
  expect(mock.destroyDetector).toHaveBeenCalledOnce();
});
