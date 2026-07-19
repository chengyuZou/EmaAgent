// 测试 MCP stdio 参数在设置表单与服务器配置之间能够逐项无损往返。
import { describe, expect, it } from 'vitest';
import {
  buildMcpServerConfig,
  createEmptyMcpFormState,
  mcpServerConfigToForm,
} from '../src/settings/mcp-form-state.js';

describe('MCP stdio 参数表单', () => {
  it('保留空格、引号、反斜杠与空字符串参数', () => {
    const args = [
      '--config',
      'D:\\My Data\\x.json',
      '--label="Ema Agent"',
      '',
      '尾部空格 ',
    ];
    const form = {
      ...createEmptyMcpFormState(),
      name: 'local-server',
      command: 'node',
      args,
    };

    const config = buildMcpServerConfig(form);
    expect(config).toMatchObject({ type: 'stdio', command: 'node', args });
    expect(mcpServerConfigToForm('local-server', config).args).toEqual(args);
  });

  it('转换时复制参数数组，避免表单修改污染已保存配置', () => {
    const config = {
      type: 'stdio' as const,
      command: 'uvx',
      args: ['mcp-server'],
    };

    const form = mcpServerConfigToForm('server', config);
    form.args.push('--debug');

    expect(config.args).toEqual(['mcp-server']);
  });
});
