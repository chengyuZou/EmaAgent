// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterStagePresentation } from '@ema-agent/characters';
import { CharacterStage } from '../src/stage/CharacterStage.js';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  modelError: undefined as ((error: Error) => void) | undefined,
}));
vi.mock('../src/api/characters.js', () => ({ charactersApi: { live2dArchive: mocks.archive } }));
vi.mock('../src/lib/tauri/tauriBridge.js', () => ({ tauriBridge: {
  isTauri: () => false,
  listenStageEmotion: async () => () => {},
  listenStageMotion: async () => () => {},
  listenStageLipSync: async () => () => {},
} }));
vi.mock('@ema-agent/live2d-react', async () => {
  const { forwardRef } = await import('react');
  return { Live2DStage: forwardRef(function Stage(props: { onError(error: Error): void }, _ref) {
    mocks.modelError = props.onError;
    return <canvas />;
  }) };
});

function presentation(name = 'ema'): CharacterStagePresentation {
  return {
    status: 'live2d', characterName: name,
    resource: {
      kind: 'live2d', name: 'model', displayName: 'Model',
      stageScale: 1, stageOffsetX: 0, stageOffsetY: 0, runtimeConfig: null,
    },
  };
}

let root: Root;
let host: HTMLDivElement;
const stageChanged = vi.fn();

async function render(name = 'ema'): Promise<void> {
  await act(async () => root.render(<CharacterStage
    targetCharacterName={name}
    presentation={presentation(name)}
    suspended={false}
    onStageChanged={stageChanged}
  />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.archive.mockResolvedValue(new Blob(['model']));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  mocks.archive.mockReset();
  mocks.modelError = undefined;
  stageChanged.mockClear();
  vi.restoreAllMocks();
});

describe('stage failure feedback', () => {
  it('shows an archive error and retries through the same API', async () => {
    mocks.archive.mockRejectedValueOnce(new Error('Model archive is missing.'));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Model archive is missing.');
    const retry = host.querySelector('button')!;
    expect(retry.textContent).toBe('重新加载');
    expect(retry.className).toContain('focus-ring');
    await act(async () => retry.click());
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.archive).toHaveBeenLastCalledWith('ema', 'model');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBeNull();
  });

  it('shows renderer errors, clears the active handle and remounts on retry', async () => {
    await render();
    const previousCanvas = host.querySelector('canvas');
    await act(async () => mocks.modelError!(new Error('WebGL initialization failed.')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('WebGL initialization failed.');
    expect(stageChanged).toHaveBeenLastCalledWith(null);
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBe(previousCanvas);
  });

  it('does not show a previous character archive failure on the new character', async () => {
    let rejectPrevious!: (error: Error) => void;
    mocks.archive.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPrevious = reject; }));
    await render('previous');
    await render('current');
    await act(async () => rejectPrevious(new Error('Previous character failed.')));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBeNull();
  });
});
