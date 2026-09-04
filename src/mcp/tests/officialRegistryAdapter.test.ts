// 验证 Official Registry 单页分页与当前 camelCase 安装字段映射.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficialRegistryAdapter } from '../market/officialRegistryAdapter.js';

afterEach(() => vi.unstubAllGlobals());

describe('OfficialRegistryAdapter', () => {
  it('每次只读取一页并保留上游 cursor', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      servers: [{ server: {
        name: 'io.example/remote',
        title: 'Remote',
        description: 'remote server',
        version: '1.0.0',
        repository: {},
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
      } }],
      metadata: { nextCursor: 'page-2' },
    })));
    vi.stubGlobal('fetch', fetch);

    await expect(new OfficialRegistryAdapter().page()).resolves.toEqual({
      items: [{
        source: 'official',
        externalId: 'io.example/remote',
        name: 'Remote',
        description: 'remote server',
        detailUrl: 'https://registry.modelcontextprotocol.io/server/io.example/remote',
      }],
      nextCursor: 'page-2',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('读取 Registry 的 camelCase 必填 Header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ server: {
      name: 'io.example/remote',
      version: '1.0.0',
      remotes: [{
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
      }],
    } }))));

    await expect(new OfficialRegistryAdapter().detail('io.example/remote')).resolves.toMatchObject({
      config: { type: 'http', url: 'https://example.com/mcp' },
      requiredInputs: [{ key: 'Authorization', target: 'header', secret: true }],
    });
  });

  it('读取 Registry 的 camelCase 包参数与环境变量', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ server: {
      name: 'io.example/local',
      version: '1.0.0',
      packages: [{
        registryType: 'npm',
        identifier: '@example/mcp',
        version: '2.0.0',
        packageArguments: [{ type: 'positional', value: '--stdio' }],
        environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }],
      }],
    } }))));

    await expect(new OfficialRegistryAdapter().detail('io.example/local')).resolves.toMatchObject({
      config: { type: 'stdio', command: 'npx', args: ['-y', '@example/mcp@2.0.0', '--stdio'] },
      requiredInputs: [{ key: 'API_KEY', target: 'env', secret: true }],
    });
  });
});
