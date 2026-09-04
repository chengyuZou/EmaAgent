// 测试 MCP 配置粘贴导入:常见包装形态、transport 键别名、SSE 拒绝与裸 URL。
import { describe, expect, it } from 'vitest';
import { McpUnsupportedTransportError } from '../errors.js';
import { parseImportedMcpServers } from '../config-import.js';

describe('MCP 配置导入', () => {
  it('吃 mcpServers 包装(Claude Desktop / mcp.so / ModelScope stdio 片段)', () => {
    expect(parseImportedMcpServers({
      mcpServers: {
        fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
      },
    })).toEqual([{
      name: 'fetch',
      config: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    }]);
  });

  it('吃 VS Code servers 包装与裸 map', () => {
    expect(parseImportedMcpServers({
      servers: { a: { url: 'https://a.example/mcp' } },
    })).toEqual([{ name: 'a', config: { type: 'http', url: 'https://a.example/mcp' } }]);

    expect(parseImportedMcpServers({
      b: { command: 'node', args: ['s.js'] },
      c: { url: 'https://c.example/mcp' },
    }).map((s) => s.name)).toEqual(['b', 'c']);
  });

  it('transport 键参与判别:streamable_http 归一、sse 拒绝、矛盾拒绝', () => {
    expect(parseImportedMcpServers({
      mcpServers: {
        remote: { transport: 'streamable_http', url: 'https://example.com/mcp' },
      },
    })).toEqual([{
      name: 'remote',
      config: { type: 'http', url: 'https://example.com/mcp' },
    }]);

    expect(() => parseImportedMcpServers({
      mcpServers: { legacy: { transport: 'sse', url: 'https://example.com/api/mcp' } },
    })).toThrow(McpUnsupportedTransportError);

    expect(() => parseImportedMcpServers({
      mcpServers: {
        conflict: { transport: 'streamable_http', command: 'uvx', args: ['x'] },
      },
    })).toThrow(/conflicts with "command"/);
  });

  it('导入只接受 JSON 对象,裸 URL 走添加服务器入口', () => {
    expect(() => parseImportedMcpServers('https://mcp.example.com/abc/mcp'))
      .toThrow(/expected a JSON object/);
  });

  it('无判别键时按 URL /sse 结尾识别旧 SSE,显式 http 不猜协议', () => {
    expect(() => parseImportedMcpServers({
      mcpServers: { legacy: { url: 'https://legacy.example/sse/' } },
    })).toThrow(McpUnsupportedTransportError);

    expect(parseImportedMcpServers({
      mcpServers: {
        current: { type: 'http', url: 'https://example.com/custom/sse' },
      },
    })).toEqual([{
      name: 'current',
      config: { type: 'http', url: 'https://example.com/custom/sse' },
    }]);
  });
});
