// 验证离屏封面渲染在销毁 Pixi ticker 前先释放 Live2D 模型。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lifecycle: [] as string[],
  model: {
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 200 })),
    scale: { set: vi.fn() },
    position: { set: vi.fn() },
    update: vi.fn(() => mocks.lifecycle.push('update-model')),
    destroy: vi.fn(),
  },
}));

vi.mock('@ema-agent/live2d-react', () => ({
  loadLive2DArchive: vi.fn(async () => mocks.model),
}));

vi.mock('@lemonneko/crop-empty-pixels', () => ({
  default: vi.fn(() => ({ width: 0, height: 0 })),
}));

vi.mock('pixi.js', () => ({
  Application: class {
    ticker = {};
    stage = {
      addChild: vi.fn(),
      removeChild: vi.fn(() => mocks.lifecycle.push('remove-model')),
    };
    renderer = {
      view: { toDataURL: vi.fn(() => 'data:image/png;base64,preview') },
      render: vi.fn(() => mocks.lifecycle.push('render-frame')),
    };
    view = this.renderer.view;

    destroy(): void {
      mocks.lifecycle.push('destroy-app');
    }
  },
}));

import { renderLive2dPreview } from '../src/lib/live2dPreview.js';

describe('renderLive2dPreview', () => {
  beforeEach(() => {
    mocks.lifecycle.length = 0;
    mocks.model.destroy.mockReset().mockImplementation(() => {
      mocks.lifecycle.push('destroy-model');
    });

    const canvas = {
      width: 0,
      height: 0,
      style: {},
      remove: vi.fn(),
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toDataURL: vi.fn(() => 'data:image/png;base64,preview'),
    };
    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => canvas),
    });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    });
  });

  it('updates the model before rendering and destroys it before Pixi', async () => {
    await expect(renderLive2dPreview(new Blob())).resolves.toBe('preview');

    expect(mocks.lifecycle).toEqual([
      'update-model',
      'render-frame',
      'remove-model',
      'destroy-model',
      'destroy-app',
    ]);
    expect(mocks.model.destroy).toHaveBeenCalledWith({
      children: true,
      texture: true,
      baseTexture: true,
    });
  });
});
