// 测试桌面宿主显隐与浏览器页面可见性的统一暂停判定。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWindowSuspended } from '../src/hooks/use-window-suspension.js';
import { tauriBridge } from '../src/lib/tauri-bridge.js';

const mocks = vi.hoisted(() => ({
  currentWindowListen: vi.fn(async () => vi.fn()),
  globalListen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    listen: mocks.currentWindowListen,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.globalListen,
}));

describe('resolveWindowSuspended', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mocks.currentWindowListen.mockClear();
    mocks.globalListen.mockClear();
  });

  it.each([
    { documentHidden: false, hostVisible: true, expected: false },
    { documentHidden: true, hostVisible: true, expected: true },
    { documentHidden: false, hostVisible: false, expected: true },
    { documentHidden: true, hostVisible: false, expected: true },
  ])('根据两个可见性来源得到 $expected', ({ documentHidden, hostVisible, expected }) => {
    expect(resolveWindowSuspended(documentHidden, hostVisible)).toBe(expected);
  });

  it('桌面宿主管理显隐时忽略 WebView2 的页面可见性误判', () => {
    expect(resolveWindowSuspended(true, true, true)).toBe(false);
    expect(resolveWindowSuspended(false, false, true)).toBe(true);
  });

  it('只接收当前窗口自己的可见性事件', async () => {
    const onVisibility = vi.fn();

    await tauriBridge.listenWindowVisibility(onVisibility);

    expect(mocks.currentWindowListen).toHaveBeenCalledWith(
      'ema://window-visibility',
      expect.any(Function),
    );
    expect(mocks.globalListen).not.toHaveBeenCalled();

    const listener = mocks.currentWindowListen.mock.calls[0]?.[1] as
      | ((event: { payload: { visible: boolean } }) => void)
      | undefined;
    listener?.({ payload: { visible: false } });
    expect(onVisibility).toHaveBeenCalledWith(false);
  });
});
