import { describe, expect, it } from 'vitest';
import { systemStatusRoute } from '../src/routes/system/status.js';
import type { SandboxStatus } from '../src/composition/tools.js';

describe('system sandbox status response', () => {
  const statuses: SandboxStatus[] = [
    { backend: 'bubblewrap', bashMode: 'sandboxed', networkAccess: 'none' },
    { backend: 'sandbox-exec', bashMode: 'sandboxed', networkAccess: 'full' },
    { backend: 'unisolated', bashMode: 'disabled', networkAccess: 'none', warning: 'backend unavailable' },
    { backend: 'unisolated', bashMode: 'unsandboxed', networkAccess: 'full' },
  ];

  it.each(statuses)('returns the Server-owned Bash policy without inferring PowerShell isolation: $bashMode', async status => {
    const route = systemStatusRoute({
      activeDataDir: '.',
      getSandboxStatus: () => status,
    });
    const response = await route.request('/sandbox');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it('reads current settings on each request rather than retaining an earlier response', async () => {
    let networkAccess: SandboxStatus['networkAccess'] = 'none';
    const route = systemStatusRoute({
      activeDataDir: '.',
      getSandboxStatus: () => ({ backend: 'bubblewrap', bashMode: 'sandboxed', networkAccess }),
    });
    expect(await (await route.request('/sandbox')).json()).toMatchObject({ networkAccess: 'none' });
    networkAccess = 'full';
    expect(await (await route.request('/sandbox')).json()).toMatchObject({ networkAccess: 'full' });
  });
});
