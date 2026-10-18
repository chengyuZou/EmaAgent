import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectBackend, resetDetectCache } from '../backends/detectBackend.js';

const boundary = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => boundary);

beforeEach(() => {
  boundary.spawnSync.mockReset();
  resetDetectCache();
});

function failProbe(result: { status: number | null; stderr: string; error?: Error }): void {
  boundary.spawnSync.mockImplementation((_executable: string, args: string[]) => {
    if (args.includes('--list')) return { status: 0, stdout: '', stderr: '' };
    return { stdout: '', ...result };
  });
}

describe('detectBackend startup check', () => {
  it('adopts a backend only after the wrapped command returns the expected marker', () => {
    boundary.spawnSync.mockReturnValue({ status: 0, stdout: 'ema-sandbox-ok\n', stderr: '' });
    expect(detectBackend().backend).toBe(process.platform === 'darwin' ? 'sandbox-exec' : 'bubblewrap');
  });

  it('reports the actual startup error instead of claiming the backend is not installed', () => {
    failProbe({ status: 1, stderr: 'creating namespace failed: Operation not permitted' });
    const result = detectBackend();
    expect(result.backend).toBe('unisolated');
    expect(result.degradeReason).toContain('Operation not permitted');
    expect(result.degradeReason).not.toContain('未安装');
  });

  it('does not adopt a backend when a successful process omits the marker', () => {
    failProbe({ status: 0, stderr: '' });
    expect(detectBackend()).toMatchObject({
      backend: 'unisolated',
      degradeReason: expect.stringContaining('ema-sandbox-ok'),
    });
  });

  it('includes process startup errors when the executable cannot be launched', () => {
    failProbe({ status: null, stderr: '', error: new Error('spawn EACCES') });
    expect(detectBackend().degradeReason).toContain('spawn EACCES');
  });
});
