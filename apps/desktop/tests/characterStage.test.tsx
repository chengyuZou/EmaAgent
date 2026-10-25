// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterStagePresentation } from '@ema-agent/characters';
import { CharacterStage } from '../src/stage/CharacterStage.js';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  setExpression: vi.fn(),
  playMotion: vi.fn(),
  emotionListener: undefined as ((emotion: string) => void) | undefined,
  motionListener: undefined as ((motion: string) => void) | undefined,
  modelError: undefined as ((error: Error) => void) | undefined,
  modelReady: undefined as (() => void) | undefined,
}));
vi.mock('../src/api/characters.js', () => ({ charactersApi: { live2dArchive: mocks.archive } }));
vi.mock('../src/lib/tauri/tauriBridge.js', () => ({ tauriBridge: {
  isTauri: () => false,
  listenStageEmotion: async (handler: (emotion: string) => void) => {
    mocks.emotionListener = handler;
    return () => { mocks.emotionListener = undefined; };
  },
  listenStageMotion: async (handler: (motion: string) => void) => {
    mocks.motionListener = handler;
    return () => { mocks.motionListener = undefined; };
  },
  listenStageLipSync: async () => () => {},
} }));
vi.mock('@ema-agent/live2d-react', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { Live2DStage: forwardRef(function Stage(props: {
    onError(error: Error): void;
    onReady(info: { hasExpressions: boolean; expressions: string[] }): void;
  }, ref) {
    useImperativeHandle(ref, () => ({ setExpression: mocks.setExpression, playMotion: mocks.playMotion }));
    mocks.modelError = props.onError;
    mocks.modelReady = () => props.onReady({ hasExpressions: false, expressions: [] });
    return <canvas />;
  }) };
});

function presentation(name = 'ema'): CharacterStagePresentation {
  return {
    status: 'live2d', characterName: name,
    resource: {
      kind: 'live2d', name: 'model', displayName: 'Model',
      stageScale: 1, stageOffsetX: 0, stageOffsetY: 0, emotionMap: {}, motionMap: {},
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
  mocks.setExpression.mockClear();
  mocks.playMotion.mockClear();
  mocks.modelError = undefined;
  mocks.modelReady = undefined;
  stageChanged.mockClear();
  vi.restoreAllMocks();
});

describe('stage failure feedback', () => {
  it('uses the model mappings supplied by Presentation for stage events', async () => {
    const current = presentation();
    if (current.status !== 'live2d') throw new Error('Expected Live2D presentation');
    await act(async () => root.render(<CharacterStage
      targetCharacterName="ema"
      presentation={{
        ...current,
        resource: {
          ...current.resource,
          emotionMap: { happy: { expression: 'Smile' } },
          motionMap: { wave: { group: 'TapBody', index: 2 } },
        },
      }}
    />));
    await act(async () => {
      mocks.emotionListener!('happy');
      mocks.motionListener!('wave');
    });
    expect(mocks.setExpression).toHaveBeenLastCalledWith('Smile');
    expect(mocks.playMotion).toHaveBeenLastCalledWith('TapBody', 2);
    await act(async () => mocks.emotionListener!('unconfigured'));
    expect(mocks.setExpression).toHaveBeenLastCalledWith(null);
  });

  it('keeps loading feedback after the archive arrives until the renderer is ready', async () => {
    await render();
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在加载角色...');
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-hidden')).not.toBe('true');
    await act(async () => mocks.modelReady!());
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.ema-character-stage-resource')?.getAttribute('data-state')).toBe('active');
  });

  it('does not show loading feedback for an intentionally blank stage', async () => {
    await act(async () => root.render(<CharacterStage
      targetCharacterName="ema"
      presentation={{ status: 'blank', characterName: 'ema' }}
    />));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('.ema-character-stage-placeholder')).toBeNull();
  });

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
