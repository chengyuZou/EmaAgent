// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { TurnSpeechControls } from '../src/chat/messages/turnSpeechControls.js';
import { AudioDetail } from '../src/settings/data/components/audioDetail.js';
import { useCharacterStore } from '../src/stores/character.js';
import { dispatchSystemEvent } from '../src/lib/events/systemEventDispatcher.js';
import {
  generateTurnSpeech, useSpeechGenerationStore,
} from '../src/chat/speech/turnSpeechGeneration.js';
import type { TurnAudioRecords, TurnSpeechGenerateResult } from '../src/api/turns.js';
import type { SessionAudioPage } from '../src/api/sessions.js';

const api = vi.hoisted(() => ({
  generate: vi.fn(), cancel: vi.fn(), audioRecords: vi.fn(), listAudio: vi.fn(),
  mergeMessages: vi.fn(), toast: vi.fn(), removePending: vi.fn(),
}));
vi.mock('../src/api/turns.js', () => ({ turnsApi: {
  generateSpeech: api.generate, cancelSpeech: api.cancel, getAudioRecords: api.audioRecords,
} }));
vi.mock('../src/api/sessions.js', () => ({ sessionsApi: { listAudio: api.listAudio } }));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));
vi.mock('../src/stores/sessionHistory.js', () => ({
  useSessionHistoryStore: { getState: () => ({ mergeTurnMessages: api.mergeMessages }) },
}));
vi.mock('../src/chat/presentation/sessionPresentation.js', () => ({
  sessionPresentation: { removePendingTurn: api.removePending },
}));
vi.mock('../src/chat/speech/turnSpeechPlayback.js', () => ({
  usePlaybackStore: (selector: (state: { queue: never[]; playbackStatus: null }) => unknown) => selector({ queue: [], playbackStatus: null }),
  replayTurn: vi.fn(), stopTurnPlayback: vi.fn(),
}));
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
  await act(async () => root.render(<TooltipProvider>{content}</TooltipProvider>));
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
  expect(scope.querySelector('[aria-label="取消语音生成"]') !== null).toBe(busy);
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
  useSpeechGenerationStore.setState({ active: new Map() });
  useCharacterStore.setState({ activeName: characterName, characters: [] });
  api.mergeMessages.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.audioRecords.mockImplementation(async (turnId: string): Promise<TurnAudioRecords> => ({
    currentCharacter: { characterName, unavailableReason: null },
    generationChoices: [{ characterName, unavailableReason: null }],
    records: saved.has(turnId) ? [{ characterName, storagePath: 'fixture.wav', createdAt: 1, durationMs: 100, byteSize: 20 }] : [],
  }));
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
        dispatchSystemEvent({ type: 'session_audio_changed', ...turn });
        resolve({ ...turn, status: 'completed', audioAvailable: true });
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
  expect(useSpeechGenerationStore.getState().active.has('turn-a-1')).toBe(true);
  await render('away');
  await render('chat');
  expectBusy(chatTurn('turn-a-1'), true);
  await render('data');
  expectBusy(dataRow('turn-a-1'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
  expectBusy(dataRow('turn-a-1'), false);
  expect(dataRow('turn-a-1').textContent).toContain('1 个角色音频');
  expect(api.generate).toHaveBeenCalledOnce();
  expect(api.mergeMessages).toHaveBeenCalledWith('session-a', 'turn-a-1');
  expect(api.cancel).not.toHaveBeenCalled();
});

it('keeps concurrent Turns and Sessions separate when one finishes and another fails', async () => {
  await render('chat');
  await startChat('turn-a-1');
  await startChat('turn-a-2');
  await render('data', 'session-b');
  await startData('turn-b-1');
  expect(useSpeechGenerationStore.getState().active.size).toBe(3);
  await render('data', 'session-a');
  expectBusy(dataRow('turn-a-1'), true);
  expectBusy(dataRow('turn-a-2'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
  expectBusy(dataRow('turn-a-1'), false);
  expectBusy(dataRow('turn-a-2'), true);
  await act(async () => pending.get('turn-a-2')!.fail());
  expect(useSpeechGenerationStore.getState().active.size).toBe(1);
  await render('chat', 'session-b');
  expectBusy(chatTurn('turn-b-1'), true);
  await act(async () => pending.get('turn-b-1')!.finish());
  expectBusy(chatTurn('turn-b-1'), false);
  expect(api.mergeMessages).toHaveBeenCalledWith('session-b', 'turn-b-1');
  expect(api.toast).toHaveBeenCalledWith('fixture synthesis failed', { variant: 'warning' });
});

it('deduplicates the same Turn even when another caller requests generation after navigation', async () => {
  await render('chat');
  await startChat('turn-a-1');
  await render('data');
  await act(async () => generateTurnSpeech('session-a', 'turn-a-1', characterName));
  expect(api.generate).toHaveBeenCalledOnce();
  expectBusy(dataRow('turn-a-1'), true);
  await act(async () => pending.get('turn-a-1')!.finish());
});
