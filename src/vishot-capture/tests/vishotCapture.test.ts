import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VishotCapture } from '../vishotCapture.js';

const mocks = vi.hoisted(() => ({ captureScreen: vi.fn<(signal: AbortSignal) => Promise<Buffer>>() }));
vi.mock('../captureScreen.js', () => ({ captureScreen: mocks.captureScreen }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const settings = { enabled: true, intervalSeconds: 30 };
  const captureScreen = mocks.captureScreen.mockReset().mockResolvedValue(Buffer.from('png'));
  const saveImage = vi.fn(async (_sessionId: string, _bytes: Buffer) => ({ path: '/image.png' }));
  const isIdle = vi.fn(() => true);
  const canReadImages = vi.fn(() => true);
  const enqueue = vi.fn(() => true);
  const onError = vi.fn();
  const capture = new VishotCapture({
    readSettings: () => settings,
    saveImage, isIdle, canReadImages,
    enqueueIfIdleForVishotCapture: enqueue,
    onError,
  });
  return { settings, captureScreen, saveImage, isIdle, canReadImages, enqueue, onError, capture };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VishotCapture', () => {
  it('没有 Session 不捕获, 设置目标后等一个完整间隔, 重复设置不重置计时', async () => {
    const f = fixture();
    f.capture.configure();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.captureScreen).not.toHaveBeenCalled();
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(20_000);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.captureScreen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.enqueue).toHaveBeenCalledWith('a', '/image.png');
    await f.capture.close();
  });

  it.each(['busy', 'noVision'] as const)('%s 跳过捕获, 下一个间隔再判断', async reason => {
    const f = fixture();
    const gate = reason === 'busy' ? f.isIdle : f.canReadImages;
    gate.mockReturnValue(false);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.captureScreen).not.toHaveBeenCalled();
    gate.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.enqueue).toHaveBeenCalledOnce();
    await f.capture.close();
  });

  it('A -> B -> A 取消原捕获, 进程未结束前不启动第二次', async () => {
    const f = fixture();
    const image = deferred<Buffer>();
    f.captureScreen.mockReturnValueOnce(image.promise);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    const signal = f.captureScreen.mock.calls[0]![0];
    f.capture.setSessionId('b');
    f.capture.setSessionId('a');
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.captureScreen).toHaveBeenCalledOnce();
    image.resolve(Buffer.from('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.saveImage).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.enqueue).toHaveBeenCalledOnce();
    await f.capture.close();
  });

  it('保存期间禁用自动捕获, 保留附件但不入队', async () => {
    const f = fixture();
    const saved = deferred<{ path: string }>();
    f.saveImage.mockReturnValueOnce(saved.promise);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.saveImage).toHaveBeenCalledOnce();
    f.settings.enabled = false;
    f.capture.configure();
    saved.resolve({ path: '/unused.png' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    await f.capture.close();
  });

  it('截图结束时变忙则不保存, 保存后变忙由队列拒绝且不重试该图片', async () => {
    const f = fixture();
    const image = deferred<Buffer>();
    f.captureScreen.mockReturnValueOnce(image.promise);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    f.isIdle.mockReturnValue(false);
    image.resolve(Buffer.from('png'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.saveImage).not.toHaveBeenCalled();
    f.isIdle.mockReturnValue(true);
    f.enqueue.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.enqueue).toHaveBeenCalledOnce();
    await f.capture.close();
  });

  it('删除正在保存图片的旧 Session 时等保存结束, 不影响新目标', async () => {
    const f = fixture();
    const saved = deferred<{ path: string }>();
    f.saveImage.mockReturnValueOnce(saved.promise);
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    f.capture.setSessionId('b');
    const finished = vi.fn();
    const cancellation = f.capture.cancelSession('a').then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    saved.resolve({ path: '/deleted-session.png' });
    await cancellation;
    expect(f.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.enqueue).toHaveBeenCalledWith('b', '/image.png');
    await f.capture.close();
  });

  it('工具截图不依赖自动开关, 两次工具调用不会同时启动截图进程', async () => {
    const f = fixture();
    f.settings.enabled = false;
    const image = deferred<Buffer>();
    f.captureScreen.mockReturnValueOnce(image.promise);
    const first = f.capture.capture(new AbortController().signal);
    const second = f.capture.capture(new AbortController().signal);
    expect(f.captureScreen).toHaveBeenCalledOnce();
    image.resolve(Buffer.from('first'));
    await expect(first).resolves.toEqual(Buffer.from('first'));
    await expect(second).resolves.toEqual(Buffer.from('png'));
    expect(f.captureScreen).toHaveBeenCalledTimes(2);
    expect(f.enqueue).not.toHaveBeenCalled();
    await f.capture.close();
  });

  it('截图失败会报告, 后续间隔仍可重试, close 后不会重启', async () => {
    const f = fixture();
    f.captureScreen.mockRejectedValueOnce(new Error('permission denied'));
    f.capture.setSessionId('a');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.enqueue).toHaveBeenCalledOnce();
    await f.capture.close();
    f.capture.setSessionId('b');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.captureScreen).toHaveBeenCalledTimes(2);
  });
});
