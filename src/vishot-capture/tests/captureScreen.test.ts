import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { captureScreen } from '../captureScreen.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function platform(value: string) {
  Object.defineProperty(process, 'platform', { value });
}

function processResult(stdout: Buffer, stderr = '', code = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code);
    });
    return child;
  });
  return child;
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
  mocks.spawn.mockReset();
});

describe('captureScreen', () => {
  it('Windows 缺少宿主原生截图时不启动 FFmpeg 回退', async () => {
    platform('win32');
    await expect(captureScreen(new AbortController().signal)).rejects.toThrow('Windows 截图需要宿主');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('macOS 从设备列表中选择屏幕, 不使用摄像头 0 或麦克风', async () => {
    platform('darwin');
    processResult(Buffer.alloc(0), '[AVFoundation] [0] Camera\n[AVFoundation] [1] Capture screen 0', 1);
    processResult(Buffer.from('PNG'));
    await captureScreen(new AbortController().signal);
    expect(mocks.spawn.mock.calls[1]![1]).toContain('1:none');
  });

  it('macOS 找不到屏幕不退回摄像头', async () => {
    platform('darwin');
    processResult(Buffer.alloc(0), '[AVFoundation] [0] Camera', 1);
    await expect(captureScreen(new AbortController().signal)).rejects.toThrow('没有找到可捕获的显示器');
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it('X11 使用真实 DISPLAY, Wayland 不使用 XWayland 假装截全屏', async () => {
    platform('linux');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    vi.stubEnv('DISPLAY', ':1.0');
    processResult(Buffer.from('PNG'));
    await captureScreen(new AbortController().signal);
    expect(mocks.spawn.mock.calls[0]![1]).toContain(':1.0');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    await expect(captureScreen(new AbortController().signal)).rejects.toThrow('Wayland');
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it('FFmpeg 报错不交付残缺图片', async () => {
    platform('linux');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    vi.stubEnv('DISPLAY', ':1');
    processResult(Buffer.from('partial'), 'Permission denied', 1);
    await expect(captureScreen(new AbortController().signal)).rejects.toThrow('Permission denied');
  });

  it('取消后等 close 才返回, 不提前允许调用方启动下一进程', async () => {
    platform('linux');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    vi.stubEnv('DISPLAY', ':1');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const failed = vi.fn();
    const pending = captureScreen(controller.signal).catch(failed);
    await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(failed).not.toHaveBeenCalled();
    child.emit('close', null);
    await pending;
    expect(failed).toHaveBeenCalledWith(controller.signal.reason);
  });
});
