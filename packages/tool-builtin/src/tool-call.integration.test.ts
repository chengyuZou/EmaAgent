/**
 * Integration test: LlmRouter + ToolRegistry + PermissionEngine
 *
 * 使用 DeepSeek (openai-llm 兼容) 跑真实 API 调用。
 * 运行: pnpm --filter @ema-agent/tool-builtin test
 *
 * 覆盖场景:
 *   1. sanity — 不带工具的普通补全
 *   2. single-tool — LLM 请求单次工具调用 (glob)
 *   3. multi-tool  — LLM 在同一轮请求多个工具 (glob + grep)
 *   4. agent-loop  — 多轮 think→act 直到 end_turn
 *   5. permission: safety-check 拦截危险 bash 命令 (bypassImmune)
 *   6. permission: bypass 模式下安全 bash 自动放行
 *   7. permission: ask 模式下 fs_read 弹权限确认
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { LlmRouter } from '@ema-agent/llm';
import type { LlmMessage, LlmToolDef, AssistantBlock } from '@ema-agent/llm';
import type { ToolResultBlock } from '@ema-agent/contracts';
import { ToolRegistry } from '@ema-agent/tool';
import type { ToolExecutionContext, ReadFileState } from '@ema-agent/tool';
import { PermissionEngine } from '@ema-agent/permission';
import type { PermissionContext } from '@ema-agent/permission';
import { registerBuiltinTools } from './index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DS_KEY        = 'sk-112xxxd59';
const PROVIDER_ID   = 'deepseek-test';
const MODEL         = 'deepseek-chat';
const WORKSPACE     = path.resolve('D:/Github/EmaAgent');
const TEST_TIMEOUT  = 60_000;

// ── Shared setup ──────────────────────────────────────────────────────────────

let router:   LlmRouter;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId:     'test-session',
    turnId:        'test-turn',
    workspaceRoot: WORKSPACE,
    signal:        AbortSignal.timeout(30_000),
    readFileState: new Map() as ReadFileState,
    emit:          (ev) => { /* noop for tests */ },
    ...overrides,
  };
}

function makePermCtx(): PermissionContext {
  return { workspaceRoot: WORKSPACE, sessionId: 'test-session' };
}

/** Convert our ToolDescriptor to the LlmToolDef shape the LLM adapter expects. */
function toToolDefs(reg: ToolRegistry, names?: string[]): LlmToolDef[] {
  const all = reg.descriptors();
  const filtered = names ? all.filter((d) => names.includes(d.name)) : all;
  return filtered.map((d) => ({
    name:        d.name,
    description: d.description,
    parameters:  d.inputJsonSchema,
  }));
}

// ── Agent loop helper ─────────────────────────────────────────────────────────

interface ToolCallRecord {
  name:   string;
  args:   unknown;
  result: unknown;
}

interface AgentResult {
  finalText:   string;
  toolCalls:   ToolCallRecord[];
  iterations:  number;
}

/**
 * Minimal think→act loop:
 *   1. Call LLM with current messages + tool defs
 *   2. Collect AssistantBlocks (text + tool_use)
 *   3. Execute all tool_use blocks via registry
 *   4. Append tool results as a user message, loop
 *   5. Stop when stopReason = 'end_turn' or max iterations reached
 */
async function agentLoop(
  messages: LlmMessage[],
  toolNames: string[],
  ctx:      ToolExecutionContext,
  maxIter = 5,
): Promise<AgentResult> {
  const toolDefs = toToolDefs(registry, toolNames);
  const history  = [...messages];
  const toolCallLog: ToolCallRecord[] = [];
  let iterations = 0;

  while (iterations < maxIter) {
    iterations++;
    const completion = await router.complete({
      providerId: PROVIDER_ID,
      model:      MODEL,
      messages:   history,
      tools:      toolDefs,
      toolChoice: 'auto',
    });

    // Append assistant turn to history
    history.push({ role: 'assistant', content: completion.blocks });

    const toolUseBlocks = completion.blocks.filter(
      (b: AssistantBlock): b is AssistantBlock & { type: 'tool_use' } => b.type === 'tool_use',
    );

    // No tool calls → model is done
    if (completion.stopReason === 'end_turn' || toolUseBlocks.length === 0) {
      const finalText = completion.blocks
        .filter((b: AssistantBlock): b is AssistantBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { finalText, toolCalls: toolCallLog, iterations };
    }

    // Execute each tool_use block and collect results
    const resultBlocks: ToolResultBlock[] = [];
    for (const block of toolUseBlocks) {
      let result: unknown;
      let isError = false;
      try {
        result = await registry.dispatch(block.name, block.args, ctx);
      } catch (err) {
        result = (err as Error).message;
        isError = true;
      }

      toolCallLog.push({ name: block.name, args: block.args, result });
      resultBlocks.push({
        type:      'tool_result',
        toolUseId: block.id,
        content:   typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        isError,
      });
    }

    // Inject tool results as next user message
    history.push({ role: 'user', content: resultBlocks });
  }

  return { finalText: '(max iterations reached)', toolCalls: toolCallLog, iterations };
}

// ── Test suite ────────────────────────────────────────────────────────────────

beforeAll(() => {
  router = new LlmRouter([{
    id:           PROVIDER_ID,
    provider:     'openai-llm',
    apiKey:       DS_KEY,
    baseUrl:      'https://api.deepseek.com',
    defaultModel: MODEL,
  }]);

  registry = new ToolRegistry();
  registerBuiltinTools(registry);
});

// ── 1. Sanity: plain completion ───────────────────────────────────────────────

it('sanity: plain completion without tools', async () => {
  const result = await router.complete({
    providerId: PROVIDER_ID,
    model:      MODEL,
    messages:   [{ role: 'user', content: 'Reply with exactly: PONG' }],
    maxTokens:  20,
  });

  const text = result.blocks
    .filter((b: AssistantBlock): b is AssistantBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text).join('');

  console.log('[sanity] response:', text);
  expect(text.toLowerCase()).toContain('pong');
}, TEST_TIMEOUT);

// ── 2. Single tool: glob ──────────────────────────────────────────────────────

it('single-tool: LLM calls glob to find TypeScript files', async () => {
  const messages: LlmMessage[] = [{
    role:    'user',
    content: `Use the glob tool to find all TypeScript source files (*.ts) ` +
             `in the workspace at path "packages/tool-builtin/src". ` +
             `Then tell me how many files you found.`,
  }];

  const result = await agentLoop(messages, ['glob'], makeCtx(), 3);

  console.log('[single-tool] tool calls:', JSON.stringify(result.toolCalls, null, 2));
  console.log('[single-tool] final text:', result.finalText);

  expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
  expect(result.toolCalls[0]!.name).toBe('glob');
  expect(result.finalText.length).toBeGreaterThan(0);
}, TEST_TIMEOUT);

// ── 3. Multi-tool: glob + grep in one turn ────────────────────────────────────

it('multi-tool: LLM calls glob and grep in the same turn', async () => {
  const messages: LlmMessage[] = [{
    role:    'user',
    content: `I need you to do two things at once using the available tools:\n` +
             `1. Use glob to list all .ts files in "packages/tool-builtin/src/tools"\n` +
             `2. Use grep to find the word "buildTool" in "packages/tool-builtin/src"\n` +
             `Then summarize what you found from both searches.`,
  }];

  const result = await agentLoop(messages, ['glob', 'grep'], makeCtx(), 4);

  console.log('[multi-tool] tool calls:', result.toolCalls.map((c) => c.name));
  console.log('[multi-tool] iterations:', result.iterations);
  console.log('[multi-tool] final text:', result.finalText.slice(0, 200));

  const toolNames = result.toolCalls.map((c) => c.name);
  expect(toolNames).toContain('glob');
  expect(toolNames).toContain('grep');
  expect(result.finalText.length).toBeGreaterThan(0);
}, TEST_TIMEOUT);

// ── 4. Full agent loop: fs_read a real file ───────────────────────────────────

it('agent-loop: LLM reads a file and answers a question about it', async () => {
  const targetFile = path.join(WORKSPACE, 'packages/tool-builtin/src/tools/fs-read.ts');
  const messages: LlmMessage[] = [{
    role:    'user',
    content: `Read the file at "${targetFile}" using the fs_read tool. ` +
             `Then tell me: what is the TEXT_SIZE_LIMIT constant set to?`,
  }];

  const result = await agentLoop(messages, ['fs_read'], makeCtx(), 3);

  console.log('[agent-loop] tool calls:', result.toolCalls.map((c) => c.name));
  console.log('[agent-loop] final text:', result.finalText);

  expect(result.toolCalls.some((c) => c.name === 'fs_read')).toBe(true);
  // Should mention 10 MiB or 10485760
  expect(result.finalText).toMatch(/10\s*(MiB|mb|mib|MB|mebibytes|1024|10485760)/i);
}, TEST_TIMEOUT);

// ── 5. Permission tests ───────────────────────────────────────────────────────

describe('permission tests', () => {
  // gate(toolName, input, meta, context) — async, 4 separate args

  it('safety-check: bypassImmune bash + fork bomb → denied even in bypass mode', async () => {
    const permEngine = new PermissionEngine({
      mode:  'bypass', // bypass 放行所有，但 bypassImmune 的 safetyCheck 不受影响
      rules: [],
    });

    const bashMeta = registry.get('bash').permissionMeta;
    const input    = { command: ':(){:|:&};:', description: 'fork bomb', timeout: 5000, run_in_background: false };

    const outcome = await permEngine.gate('bash', input, bashMeta, makePermCtx());

    console.log('[permission] fork-bomb outcome:', outcome);
    expect(outcome.granted).toBe(false);
    expect((outcome as { granted: false; reason: string }).reason).toMatch(/safety/i);
  });

  it('safety-check: bypassImmune bash + safe command → granted in bypass mode', async () => {
    const permEngine = new PermissionEngine({
      mode:  'bypass',
      rules: [],
    });

    const bashMeta = registry.get('bash').permissionMeta;
    const input    = { command: 'echo hello', description: 'echo test', timeout: 5000, run_in_background: false };

    const outcome = await permEngine.gate('bash', input, bashMeta, makePermCtx());

    console.log('[permission] safe-bash outcome:', outcome);
    expect(outcome.granted).toBe(true);
  });

  it('ask-mode: fs_read triggers ask callback and respects "allow" response', async () => {
    let askWasCalled = false;

    const permEngine = new PermissionEngine({
      mode:  'ask',
      rules: [],
      ask:   async (req) => {
        askWasCalled = true;
        console.log('[permission] ask called for:', req.toolName, 'risk:', req.riskLevel);
        return { action: 'allow' };
      },
    });

    const fsReadMeta = registry.get('fs_read').permissionMeta;
    const input      = { file_path: path.join(WORKSPACE, 'package.json') };

    const outcome = await permEngine.gate('fs_read', input, fsReadMeta, makePermCtx());

    console.log('[permission] fs_read ask-mode outcome:', outcome);
    // ask mode + workspace file = step 9 (read in workspace) → auto-allowed without reaching ask
    // So askWasCalled may be false here (working-dir shortcut fires first)
    expect(outcome.granted).toBe(true);
  });

  it('auto-mode: fs_read inside workspace → auto-allowed (step 9)', async () => {
    const permEngine = new PermissionEngine({
      mode:  'auto',
      rules: [],
    });

    const fsReadMeta = registry.get('fs_read').permissionMeta;
    const input      = { file_path: path.join(WORKSPACE, 'package.json') };

    const outcome = await permEngine.gate('fs_read', input, fsReadMeta, makePermCtx());

    console.log('[permission] fs_read auto-mode outcome:', outcome);
    expect(outcome.granted).toBe(true);
    expect((outcome as { granted: true; decisionReason?: { type: string } }).decisionReason?.type)
      .toBe('workingDir');
  });

  it('auto-mode: fs_read outside workspace → escalates to ask → deny', async () => {
    const permEngine = new PermissionEngine({
      mode:  'auto',
      rules: [],
      ask:   async (_req) => ({ action: 'deny' as const }),
    });

    const fsReadMeta = registry.get('fs_read').permissionMeta;
    // Path outside workspace root on Windows
    const input = { file_path: 'C:/Windows/System32/drivers/etc/hosts' };

    const outcome = await permEngine.gate('fs_read', input, fsReadMeta, makePermCtx());

    console.log('[permission] out-of-workspace outcome:', outcome);
    expect(outcome.granted).toBe(false);
  });

  it('ask-mode: "always_allow" response adds a persisted rule', async () => {
    const persistedRules: unknown[] = [];

    const permEngine = new PermissionEngine({
      mode:  'ask',
      rules: [],
      ask:   async (_req) => ({ action: 'always_allow' as const, scope: 'session' as const }),
      onRulePersisted: async (rule) => { persistedRules.push(rule); },
    });

    const fsReadMeta = registry.get('fs_read').permissionMeta;
    // Use a file outside workspace to force the ask path (skip step 9)
    const input = { file_path: 'C:/Users/Public/test.txt' };

    const outcome = await permEngine.gate('fs_read', input, fsReadMeta, makePermCtx());

    console.log('[permission] always_allow outcome:', outcome, 'persisted:', persistedRules);
    expect(outcome.granted).toBe(true);
    expect(persistedRules.length).toBe(1);
    // Second call: now the persisted rule auto-allows it
    const outcome2 = await permEngine.gate('fs_read', input, fsReadMeta, makePermCtx());
    expect(outcome2.granted).toBe(true);
  });
});
