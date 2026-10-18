import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectBackend, resetDetectCache } from '../backends/detectBackend.js';

const boundary = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  platform: 'windows' as 'windows' | 'linux' | 'macos',
}));
vi.mock('node:child_process', () => boundary);
vi.mock('../discovery/platform.js', () => ({ getPlatform: () => boundary.platform }));

beforeEach(() => {
  boundary.spawnSync.mockReset();
  boundary.platform = 'windows';
  resetDetectCache();
});

function failProbe(result: { status: number | null; stdout?: Buffer; stderr?: Buffer; error?: Error }): void {
  boundary.spawnSync.mockImplementation((_executable: string, args: string[]) => {
    if (args.includes('--list')) return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...result };
  });
}

describe('detectBackend startup check', () => {
  it.each(['', '\uFEFF'])('decodes UTF-16LE launcher output with BOM %j', bom => {
    failProbe({
      status: 1,
      stdout: Buffer.from(`${bom}WSL 启动失败: 请检查发行版配置.\r\r\n帮助说明`, 'utf16le'),
    });
    const result = detectBackend();
    expect(result.degradeDetails).toBe('WSL 启动失败: 请检查发行版配置.\n帮助说明');
    expect(result.degradeDetails).not.toContain('\u0000');
    expect(result.degradeReason).not.toContain('帮助说明');
  });

  it.each(['windows', 'linux', 'macos'] as const)('preserves UTF-8 child output on %s', platform => {
    boundary.platform = platform;
    failProbe({ status: 1, stderr: Buffer.from('creating namespace failed: 操作不允许', 'utf8') });
    expect(detectBackend().degradeDetails).toBe('creating namespace failed: 操作不允许');
  });

  it('retains both stderr and stdout without putting them in the short reason', () => {
    failProbe({ status: 1, stdout: Buffer.from('Usage: wsl.exe\nHelp text'), stderr: Buffer.from('Startup error') });
    const result = detectBackend();
    expect(result.degradeDetails).toBe('Startup error\n\nUsage: wsl.exe\nHelp text');
    expect(result.degradeReason).toBe('WSL 中的 bubblewrap 启动检查未通过.');
  });

  it('stops when the WSL environment check itself fails', () => {
    boundary.spawnSync.mockReturnValue({
      status: 1, stdout: Buffer.from('WSL 用法说明', 'utf16le'), stderr: Buffer.alloc(0),
    });
    expect(detectBackend()).toMatchObject({
      backend: 'unisolated',
      degradeReason: 'WSL 环境 启动检查未通过.',
      degradeDetails: 'WSL 用法说明',
    });
    expect(boundary.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports a missing Windows launcher without trying the sandbox command', () => {
    boundary.spawnSync.mockReturnValue({
      status: null, stdout: null, stderr: null, error: Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }),
    });
    expect(detectBackend().degradeReason).toContain('未找到 WSL');
    expect(boundary.spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(['windows', 'linux', 'macos'] as const)('adopts %s backend only after receiving the marker', platform => {
    boundary.platform = platform;
    boundary.spawnSync.mockReturnValue({
      status: 0, stdout: Buffer.from('ema-sandbox-ok\n'), stderr: Buffer.alloc(0),
    });
    expect(detectBackend()).toEqual({ backend: platform === 'macos' ? 'sandbox-exec' : 'bubblewrap' });
  });

  it('records a missing success marker in the expandable details', () => {
    failProbe({ status: 0 });
    expect(detectBackend()).toMatchObject({
      backend: 'unisolated',
      degradeDetails: expect.stringContaining('ema-sandbox-ok'),
    });
  });

  it('includes a process startup error in the details', () => {
    failProbe({ status: null, error: new Error('spawn EACCES') });
    expect(detectBackend().degradeDetails).toContain('spawn EACCES');
  });
});
