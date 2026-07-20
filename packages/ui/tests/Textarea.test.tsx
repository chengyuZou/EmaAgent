// 测试 Textarea 自动增高的内容测量、宽度观察与帧合并行为。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Textarea } from '../src/components/Textarea.js';

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  emitWidth(width: number): void {
    this.callback([
      { contentRect: { width } } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }
}

let container: HTMLDivElement;
let root: Root;
let scrollHeight: number;
let nextFrameId: number;
let pendingFrames: Map<number, FrameRequestCallback>;

function flushAnimationFrames(): void {
  const frames = [...pendingFrames.values()];
  pendingFrames.clear();
  frames.forEach((callback) => callback(0));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  ResizeObserverMock.instances = [];
  scrollHeight = 100;
  nextFrameId = 1;
  pendingFrames = new Map();

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    pendingFrames.set(frameId, callback);
    return frameId;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((frameId: number) => {
    pendingFrames.delete(frameId);
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 300,
  } as DOMRect);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    lineHeight: '20px',
  } as CSSStyleDeclaration);
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Textarea auto grow', () => {
  it('measures controlled content without rebuilding the width observer', () => {
    act(() => {
      root.render(
        <Textarea value="first" onChange={vi.fn()} minRows={1} maxRows={3} />,
      );
    });

    const textarea = container.querySelector('textarea')!;
    const wrapper = textarea.parentElement!;
    const observer = ResizeObserverMock.instances[0]!;

    expect(textarea.style.height).toBe('60px');
    expect(textarea.style.overflowY).toBe('auto');
    expect(observer.observe).toHaveBeenCalledWith(wrapper);
    expect(observer.observe).not.toHaveBeenCalledWith(textarea);

    scrollHeight = 40;
    act(() => {
      root.render(
        <Textarea value="second" onChange={vi.fn()} minRows={1} maxRows={3} />,
      );
    });

    expect(ResizeObserverMock.instances).toHaveLength(1);
    expect(textarea.style.height).toBe('40px');
    expect(textarea.style.overflowY).toBe('hidden');

    observer.emitWidth(300);
    expect(pendingFrames).toHaveLength(0);

    scrollHeight = 55;
    observer.emitWidth(420);
    observer.emitWidth(460);
    expect(pendingFrames).toHaveLength(1);

    act(() => flushAnimationFrames());
    expect(textarea.style.height).toBe('55px');
  });

  it('remeasures uncontrolled content after an input event', () => {
    scrollHeight = 20;
    act(() => {
      root.render(<Textarea defaultValue="first" minRows={1} maxRows={4} />);
    });

    const textarea = container.querySelector('textarea')!;
    expect(textarea.style.height).toBe('20px');

    scrollHeight = 70;
    act(() => {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(pendingFrames).toHaveLength(1);

    act(() => flushAnimationFrames());
    expect(textarea.style.height).toBe('70px');
  });
});
