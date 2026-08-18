// 工具目录投影: 只暴露静态契约事实, builtin/mcp 来源正确, inputSchema 转 JSON Schema。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTool } from '../Tool/buildTool.js';
import type { PermissionResult } from '@ema-agent/permission';
import { describeToolForCatalog } from '../catalog.js';

const passthrough = async (): Promise<PermissionResult> => ({
  behavior: 'passthrough',
  message: 'test',
});

const simpleBuiltin = buildTool({
  name: 'Sample',
  description: '样例工具说明',
  inputSchema: z.object({
    path: z.string().describe('文件路径'),
    lines: z.number().optional().describe('读取行数'),
  }),
  checkPermissions: passthrough,
  execute: async () => 'ok',
});

const mcpTool = buildTool({
  name: 'search_code',
  description: 'mcp 工具',
  inputSchema: z.object({ query: z.string() }),
  origin: { kind: 'mcp', serverName: 'github', serverToolName: 'search_code' },
  checkPermissions: passthrough,
  execute: async () => 'ok',
});

const withMapping = buildTool({
  name: 'Mapped',
  description: '自定义结果投影',
  inputSchema: z.object({ x: z.string() }),
  checkPermissions: passthrough,
  execute: async () => ({ a: 1 }),
  mapResultToModelContent: () => '投影后的内容',
});

describe('describeToolForCatalog', () => {
  it('builtin 工具: 来源与身份正确', () => {
    const item = describeToolForCatalog(simpleBuiltin);
    expect(item.kind).toBe('builtin');
    expect(item.serverName).toBeUndefined();
    expect(item.id).toBe('Sample');
    expect(item.name).toBe('Sample');
    expect(item.description).toBe('样例工具说明');
    expect(item.maxResultBytes).toBe(50 * 1024);
    expect(item.hasCustomResultMapping).toBe(false);
  });

  it('inputSchema 转 JSON Schema 且带 describe 说明', () => {
    const item = describeToolForCatalog(simpleBuiltin);
    const schema = item.inputSchema as {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties?.path.description).toBe('文件路径');
    expect(schema.properties?.lines).toBeDefined();
    expect(schema.required).toContain('path');
  });

  it('mcp 工具: 来源 Server 身份正确', () => {
    const item = describeToolForCatalog(mcpTool);
    expect(item.kind).toBe('mcp');
    expect(item.serverName).toBe('github');
    expect(item.serverToolName).toBe('search_code');
  });

  it('自定义结果投影时标记 hasCustomResultMapping', () => {
    expect(describeToolForCatalog(withMapping).hasCustomResultMapping).toBe(true);
  });
});
