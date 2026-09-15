// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServerObjectUrl } from '../src/lib/serverFileUrl.js';
import { ServerImage } from '../src/lib/ServerImage.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  value: vi.fn(),
});

vi.mock('../src/lib/serverFileUrl.js', () => ({
  fetchServerObjectUrl: vi.fn(),
}));

describe('ServerImage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('资源完成时间变化后重新读取先前缺失的图片', async () => {
    vi.mocked(fetchServerObjectUrl)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('blob:preview-ready');

    await act(async () => {
      root.render(createElement(ServerImage, {
        path: '/api/characters/ema/live2d/ema/preview',
        alt: 'ema',
        contentUpdatedAt: 1,
      }));
    });
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      root.render(createElement(ServerImage, {
        path: '/api/characters/ema/live2d/ema/preview',
        alt: 'ema',
        contentUpdatedAt: 2,
      }));
    });

    expect(fetchServerObjectUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.src).toBe('blob:preview-ready');
  });
});
