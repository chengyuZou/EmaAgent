// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { TurnSpeechControls } from '../src/chat/messages/turnSpeechControls.js';
import { AudioDetail } from '../src/settings/data/components/audioDetail.js';
import { useCharacterStore } from '../src/stores/character.js';
import { dispatchSystemEvent } from '../src/lib/events/systemEventDispatcher.js';
import { audioGenerationKey, useAudioStore, receiveAudioSystemEvent } from '../src/stores/audio.js';
import { MainView, useMainNavigationStore } from '../src/layout/navigation.js';
import { subscribeSystemEvent } from '../src/lib/events/systemEventDispatcher.js';
import type { TurnAudioRecords, TurnSpeechGenerateResult } from '../src/api/turns.js';
import type { SessionAudioPage } from '../src/api/sessions.js';

const api = vi.hoisted(() => ({
  generate: vi.fn(), cancel: vi.fn(), audioRecords: vi.fn(), listAudio: vi.fn(),
  characterAvailability: vi.fn(), speechAvailabilityList: vi.fn(),
  toast: vi.fn(), removePending: vi.fn(),
}));
vi.mock('../src/api/turns.js', () => ({ turnsApi: {
  generateSpeech: api.generate, cancelSpeech: api.cancel, getAudioRecords: api.audioRecords,
  getCharacterSpeechAvailability: api.characterAvailability, listSpeechAvailability: api.speechAvailabilityList,
} }));
vi.mock('../src/api/sessions.js', () => ({ sessionsApi: { listAudio: api.listAudio } }));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));
vi.mock('../src/stores/audioPlayback.js', () => ({
  useAudioPlaybackStore: Object.assign(
    (selector: (state: { owner: null; playbackStatus: null }) => unknown) => selector({ owner: null, playbackStatus: null }),
    { getState: () => ({ playSavedAudio: vi.fn(), stopPlayback: vi.fn() }) },
  ),
}));
vi.mock('../src/api/audio.js', () => ({ audioApi: { cancelGeneration: api.cancel } }));
vi.mock('../src/lib/audio/audioPlayer.js', () => ({
  AudioPlayer: ({ title }: { title: string }) => <span data-saved-audio>{title}</span>,
}));

const characterName = 'Fixture agent';
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations');
const turns = [
  { sessionId: 'session-a', turnId: 'turn-a-1' },
  { sessionId: 'session-a', turnId: 'turn-a-2' },
  { sessionId: 'session-b', turnId: 'turn-b-1' },
];
let host: HTMLDivElement;
let root: Root;
let saved: Set<string>;
let pending: Map<string, { finish(): void; fail(): void }>;
let unsubscribeAudio: () => void;

async function render(view: 'chat' | 'data' | 'away', sessionId = 'session-a'): Promise<void> {
  let content: ReactNode = <div>Another page</div>;
  if (view === 'chat') {
    content = turns.filter(turn => turn.sessionId === sessionId).map(turn => (
      <section key={turn.turnId} data-turn={turn.turnId}>
        <TurnSpeechControls sessionId={sessionId} turnId={turn.turnId} />
      </section>
    ));
  } else if (view === 'data') {
    content = <AudioDetail key={sessionId} sessionId={sessionId} active />;
  }
  await act(async () => {
    useMainNavigationStore.setState({ activeView: view === 'data' ? MainView.Settings : MainView.Chat, viewedSessionId: sessionId });
    root.render(<TooltipProvider>{content}</TooltipProvider>);
  });
}

async function selectMenu(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.startsWith(label));
  if (!item) throw new Error(`Menu item not found: ${label}`);
  expect(item.getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => item.click());
}

function chatTurn(turnId: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-turn="${turnId}"]`)!;
}

function dataRow(turnId: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>('.ema-turn-audio-row')]
    .find(element => element.querySelector('strong')?.textContent?.includes(turnId));
  if (!row) throw new Error(`Audio row not found: ${turnId}`);
  return row;
}

async function startChat(turnId: string): Promise<void> {
  await selectMenu(chatTurn(turnId).querySelector<HTMLElement>('[aria-label="语音操作"]')!, '生成音频');
}

async function startData(turnId: string): Promise<void> {
  const trigger = [...dataRow(turnId).querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === '重新生成音频')!;
  await selectMenu(trigger, characterName);
}

function expectBusy(scope: ParentNode, busy: boolean): void {
  expect(scope.querySelector('[aria-label="取消语音生成"], [aria-label*="的语音生成"]') !== null).toBe(busy);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  if (!HTMLElement.prototype.getAnimations) {
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] });
  }
  saved = new Set();
  pending = new Map();
  unsubscribeAudio = subscribeSystemEvent(receiveAudioSystemEvent);
  useCharacterStore.setState({ activeName: characterName, characters: [] });
  api.cancel.mockResolvedValue(undefined);
  api.audioRecords.mockImplementation(async (turnId: string): Promise<TurnAudioRecords> =>
    saved.has(turnId) ? [{ audioId: 'audio-' + turnId, characterName, audioStatus: 'ready', createdAtMs: 1, durationMs: 100, fileSizeBytes: 20, failureMessage: null }] : []);
  api.characterAvailability.mockImplementation(async (_turnId: string, selectedCharacter: string) => ({
    characterName: selectedCharacter, unavailableReason: null,
  }));
  api.speechAvailabilityList.mockResolvedValue([{ characterName, unavailableReason: null }]);
  api.listAudio.mockImplementation(async (sessionId: string): Promise<SessionAudioPage> => ({
    items: turns.filter(turn => turn.sessionId === sessionId).map((turn, index) => ({
      turnId: turn.turnId, createdAt: index + 1, status: 'completed',
      audioCount: saved.has(turn.turnId) ? 1 : 0, totalDurationMs: 0, totalByteSize: 0,
    })),
    nextCursor: null,
  }));
  api.generate.mockImplementation((turnId: string) => new Promise<TurnSpeechGenerateResult>((resolve, reject) => {
    const turn = turns.find(candidate => candidate.turnId === turnId)!;
    pending.set(turnId, {
      finish() {
        saved.add(turnId);
        pending.delete(turnId);
        dispatchSystemEvent({ type: 'session_audio_changed', ...turn, audioId: 'audio-' + turnId, characterName, audioStatus: 'ready' });
        resolve({ ...turn, audioId: 'audio-' + turnId, characterName, type: 'speech_generate_completed', audioAvailable: true });
      },
      fail() {
        pending.delete(turnId);
        reject(new Error('fixture synthesis failed'));
      },
    });
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    for (const operation of pending.values()) operation.fail();
    root.unmount();
  });
  unsubscribeAudio();
  host.remove();
  if (originalAnimations) {
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalAnimations);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  }
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(['chat', 'data'] as const)('preserves generation started in %s across both views and a remount', async source => {
  await render(source);
  if (source === 'chat') await startChat('turn-a-1');
  else await startData('turn-a-1');
  expect(useAudioStore.getState().generationsByTurnAndCharacter.has(
    audioGenerationKey('turn-a-1', characterName),
  )).toBe(true);
  await render('away');
  await render('chat');
  expectBusy(chatTurn('turn-a-1'), true);
  await render('data');
  expectBusy(dataRow('turn-a-1'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
  expectBusy(dataRow('turn-a-1'), false);
  expect(dataRow('turn-a-1').textContent).toContain('1 条音频');
  expect(api.generate).toHaveBeenCalledOnce();
  expect(api.cancel).not.toHaveBeenCalled();
});

it('keeps concurrent Turns and Sessions separate when one finishes and another fails', async () => {
  await render('chat');
  await startChat('turn-a-1');
  await startChat('turn-a-2');
  await render('data', 'session-b');
  await startData('turn-b-1');
  expect(useAudioStore.getState().generationsByTurnAndCharacter.size).toBe(3);
  await render('data', 'session-a');
  expectBusy(dataRow('turn-a-1'), true);
  expectBusy(dataRow('turn-a-2'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
  expectBusy(dataRow('turn-a-1'), false);
  expectBusy(dataRow('turn-a-2'), true);
  await act(async () => pending.get('turn-a-2')!.fail());
  expect(useAudioStore.getState().generationsByTurnAndCharacter.size).toBe(1);
  await render('chat', 'session-b');
  expectBusy(chatTurn('turn-b-1'), true);
  await act(async () => pending.get('turn-b-1')!.finish());
  expectBusy(chatTurn('turn-b-1'), false);
  expect(api.toast).toHaveBeenCalledWith('fixture synthesis failed', { variant: 'warning' });
});

it('deduplicates the same Turn even when another caller requests generation after navigation', async () => {
  await render('chat');
  await startChat('turn-a-1');
  await render('data');
  await act(async () => useAudioStore.getState().generateTurnSpeech({ sessionId: 'session-a', turnId: 'turn-a-1', characterName }));
  expect(api.generate).toHaveBeenCalledOnce();
  expectBusy(dataRow('turn-a-1'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
});

it('Data 同一轮的不同角色可以连续点击生成, 同角色不能重复发送', async () => {
  const completions = new Map<string, (result: TurnSpeechGenerateResult) => void>();
  api.speechAvailabilityList.mockResolvedValue(
    [characterName, 'Another character'].map(name => ({ characterName: name, unavailableReason: null })),
  );
  api.generate.mockImplementation((_turnId: string, selectedCharacter: string) =>
    new Promise<TurnSpeechGenerateResult>(resolve => completions.set(selectedCharacter, resolve)));
  await render('data');
  await startData('turn-a-1');
  const trigger = [...dataRow('turn-a-1').querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === '重新生成音频')!;
  expect(trigger.disabled).toBe(false);
  await selectMenu(trigger, 'Another character');
  expect(dataRow('turn-a-1').querySelector('.ema-turn-audio-toggle')?.getAttribute('aria-expanded')).toBe('false');
  expect(api.audioRecords).not.toHaveBeenCalled();
  await act(async () => {
    await useAudioStore.getState().generateTurnSpeech({ sessionId: 'session-a', turnId: 'turn-a-1', characterName });
  });
  expect(api.generate).toHaveBeenCalledTimes(2);
  expect(useAudioStore.getState().generationsByTurnAndCharacter.size).toBe(2);
  await act(async () => completions.get(characterName)!({
    sessionId: 'session-a', turnId: 'turn-a-1', characterName,
    audioId: 'first', type: 'speech_generate_completed', audioAvailable: true,
  }));
  expect(useAudioStore.getState().generationsByTurnAndCharacter.has(
    audioGenerationKey('turn-a-1', 'Another character'),
  )).toBe(true);
  expectBusy(dataRow('turn-a-1'), true);
  await act(async () => completions.get('Another character')!({
    sessionId: 'session-a', turnId: 'turn-a-1', characterName: 'Another character',
    audioId: 'second', type: 'speech_generate_cancelled', audioAvailable: false,
  }));
  expect(useAudioStore.getState().generationsByTurnAndCharacter.size).toBe(0);
  expectBusy(dataRow('turn-a-1'), false);
});

it('Chat 切换角色后不接受旧可用性结果, 关闭菜单时取消当前查询', async () => {
  const requests: Array<{
    characterName: string;
    signal: AbortSignal;
    resolve(availability: { characterName: string; unavailableReason: string | null }): void;
  }> = [];
  api.characterAvailability.mockImplementation((_turnId: string, selectedCharacter: string, signal: AbortSignal) => (
    new Promise(resolve => requests.push({ characterName: selectedCharacter, signal, resolve }))
  ));
  await render('chat');
  const trigger = chatTurn('turn-a-1').querySelector<HTMLElement>('[aria-label="语音操作"]')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(requests[0]?.characterName).toBe(characterName);
  await act(async () => useCharacterStore.setState({ activeName: 'Another character' }));
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(requests[1]?.characterName).toBe('Another character');
  await act(async () => {
    requests[1]!.resolve({ characterName: 'Another character', unavailableReason: '新角色没有主参考音频' });
    requests[0]!.resolve({ characterName, unavailableReason: null });
  });
  const generate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.startsWith('生成音频'))!;
  expect(generate.getAttribute('aria-disabled')).toBe('true');
  expect(generate.textContent).toContain('新角色没有主参考音频');
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(requests[1]!.signal.aborted).toBe(true);
});

it('Data 菜单打开时单独刷新生成可用性, 不因配置变化读取录音', async () => {
  await render('data');
  const trigger = [...dataRow('turn-a-1').querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === '重新生成音频')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(api.speechAvailabilityList).toHaveBeenCalledTimes(1);
  api.speechAvailabilityList.mockResolvedValue([{ characterName, unavailableReason: '尚未绑定 TTS 模型' }]);
  await act(async () => dispatchSystemEvent({ type: 'model_bindings_changed' }));
  expect(api.speechAvailabilityList).toHaveBeenCalledTimes(2);
  const generate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.startsWith(characterName))!;
  expect(generate.getAttribute('aria-disabled')).toBe('true');
  expect(generate.textContent).toContain('尚未绑定 TTS 模型');
  expect(api.audioRecords).not.toHaveBeenCalled();
  expect(dataRow('turn-a-1').querySelector('.ema-turn-audio-toggle')?.getAttribute('aria-expanded')).toBe('false');
});
