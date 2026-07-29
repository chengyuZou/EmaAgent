// 装配 MCP、Marketplace 与 Skill 的本地扩展入口，不在构造阶段连接服务器或扫描目录。

import path from 'node:path';
import {
  MarketRegistry,
  MarketSourceStore,
} from '@ema-agent/marketplace';
import {
  McpMarketAdapter,
  McpRegistry,
  McpServerStore,
  type McpStdioLaunchIntent,
} from '@ema-agent/mcp';
import type { PermissionEngine } from '@ema-agent/permission';
import {
  SkillInstaller,
  SkillMarketAdapter,
  SkillRunner,
  SkillStore,
} from '@ema-agent/skills';
import {
  MarketSourcesRepo,
  McpServersRepo,
  SkillsRepo,
  type Database,
} from '@ema-agent/storage';
import type { ToolRegistry } from '@ema-agent/tools';
import { profileDir } from '../storage-locations/index.js';

type ExtensionPermission = Pick<PermissionEngine, 'gate'>;

export function createExtensionRuntime(
  profileDb: Database,
  tools: ToolRegistry,
  permission: ExtensionPermission,
  localMcpStdioEnabled: boolean,
) {
  const mcpStdioGate = async (
    intent: McpStdioLaunchIntent,
  ): Promise<boolean> => {
    if (!localMcpStdioEnabled) return false;

    // 环境变量值可能包含密钥；审批只展示键名，实际执行仍使用同一份冻结配置。
    const environmentKeys = Object.keys(intent.environment ?? {}).sort();
    const outcome = await permission.gate(
      'mcp_stdio_launch',
      {
        operation: intent.operation,
        serverName: intent.serverName,
        command: intent.command,
        args: [...intent.args],
        cwd: intent.cwd ?? null,
        environmentKeys,
      },
      { riskLevel: 'high', accessType: 'execute' },
      { workspaceRoot: process.cwd() },
    );
    return outcome.granted;
  };

  const mcpRegistry = new McpRegistry(
    new McpServerStore(new McpServersRepo(profileDb.sqlite)),
    tools,
    mcpStdioGate,
    localMcpStdioEnabled,
  );

  const marketRegistry = new MarketRegistry();
  marketRegistry.registerAdapter(new McpMarketAdapter());
  marketRegistry.registerAdapter(new SkillMarketAdapter());

  const skillStore = new SkillStore(
    new SkillsRepo(profileDb.sqlite),
    [{
      path: path.join(profileDir(), 'skills'),
      source: 'user',
    }],
  );

  return {
    mcpRegistry,
    marketRegistry,
    marketSourceStore: new MarketSourceStore(
      new MarketSourcesRepo(profileDb.sqlite),
    ),
    skillStore,
    skillRunner: new SkillRunner(skillStore),
    skillInstaller: new SkillInstaller(skillStore),
  };
}
