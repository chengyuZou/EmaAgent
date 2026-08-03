// 测试根 Turn 使用同一份真实能力快照生成模型可见与运行时可执行 Tool Manifest。

import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_SETTINGS, TurnBudget } from '@ema-agent/agent';
import { DEFAULT_ATTACHMENT_SETTINGS } from '@ema-agent/attachment';
import { DEFAULT_CONTEXT_COMPACTION_SETTINGS } from '@ema-agent/context';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { PromptAssembler } from '@ema-agent/prompts';
import type { Turn } from '@ema-agent/session';
import { ToolRegistry, type BuiltTool } from '@ema-agent/tools';
import { BashTool } from '@ema-agent/tool-builtin';
import { TurnToolsBuilder } from '../turnTools.js';
import type { TurnInput } from '../types.js';

const sessionId = 'session-tool-snapshot' as SessionId;
const turnId = 'turn-tool-snapshot' as TurnId;

const backgroundDocumentedTool: BuiltTool = BashTool;

const turn: Turn = {
  id: turnId,
  sessionId,
  triggerType: 'userMessage',
  executionProfile: 'work',
  narrativePolicy: 'off',
  status: 'running',
  userInput: '运行后台任务',
  startedAt: 1,
  completedAt: null,
  errorCode: null,
  errorMessage: null,
  iterations: 0,
  usageInputTokens: 0,
  usageOutputTokens: 0,
};

const input: TurnInput = {
  userInput: turn.userInput,
  prompt: new PromptAssembler().build([]),
  model: {
    providerId: 'provider-test',
    model: 'model-test',
    capabilities: {} as never,
  },
  settings: {
    agent: DEFAULT_AGENT_SETTINGS,
    attachment: DEFAULT_ATTACHMENT_SETTINGS,
    contextCompaction: DEFAULT_CONTEXT_COMPACTION_SETTINGS,
    permissionMode: 'default',
  },
  workspaceRoot: 'D:\\workspace',
  requestDegradations: [],
};

function createBuilder(withBackgroundProcesses: boolean): TurnToolsBuilder {
  const tools = new ToolRegistry();
  tools.register(backgroundDocumentedTool);
  return new TurnToolsBuilder({
    session: {} as never,
    tools,
    permission: {} as never,
    llm: {} as never,
    getCommandRunner: () => ({} as never),
    backgroundProcesses: withBackgroundProcesses ? {} as never : undefined,
  });
}

describe('TurnToolsBuilder 能力快照', () => {
  it('后台进程能力与 description 共同进入同一 Manifest', async () => {
    const enabled = await createBuilder(true).prepare({
      turn,
      input,
      signal: new AbortController().signal,
      budget: new TurnBudget(),
    });
    const enabledNames = enabled.policy.manifestSnapshot().entries
      .map((entry) => entry.name);
    expect(enabledNames).toEqual(['Bash']);
    expect(enabled.policy.manifestSnapshot().entries[0]?.description)
      .toBe(BashTool.description);

    const disabled = await createBuilder(false).prepare({
      turn,
      input,
      signal: new AbortController().signal,
      budget: new TurnBudget(),
    });
    const disabledNames = disabled.policy.manifestSnapshot().entries
      .map((entry) => entry.name);
    expect(disabledNames).not.toContain('Bash');
  });
});
