// 提供当前 Turn 内主 Agent 和子 Agent 共用的临时读写工具。

import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionScope } from '@ema-agent/tools';
import { estimateTextTokens } from '@ema-agent/token';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import {
  SCRATCHPAD_KEY_RE,
  writeScratchpadEntry,
  readScratchpadEntry,
  listScratchpadEntries,
  deleteScratchpadEntry,
  clearScratchpad,
} from './ScratchpadStore.js';

// ── 约束 ───────────────────────────────────────────────────────────────────────

/** key 必须在所有平台(Windows + POSIX)作文件名安全。 */
export const KEY_RE = SCRATCHPAD_KEY_RE;
const KEY_SCHEMA = z.string().regex(KEY_RE, 'Key must be 1–64 characters: letters, digits, _ or -');

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function requireDir(scope: ToolExecutionScope): string {
  if (!scope.scratchpadDir) {
    throw new Error(
      'Scratchpad is not available in this context. ' +
      'It is only enabled during agent-mode turns with a configured data directory.',
    );
  }
  return scope.scratchpadDir;
}


// ── ScratchpadWrite ───────────────────────────────────────────────────────────

const writeSchema = z.object({
  key: KEY_SCHEMA.describe(
    'Identifier for this scratchpad entry. Use a descriptive name like "research_summary" or "task_result_2".',
  ),
  value: z.string().describe(
    'Text content to store. Overwrites any existing value for this key. Max 256 KB per value, 8 MB total.',
  ),
  append: z.boolean().optional().describe(
    'When true, appends value to any existing content (with a newline separator) instead of overwriting.',
  ),
});

export const ScratchpadWriteTool = buildTool<
  z.infer<typeof writeSchema>,
  { key: string; bytes: number; estimatedTokens: number }
>({
  id: BuiltinTools.ScratchpadWrite.id,
  name: BuiltinTools.ScratchpadWrite.name,
  description: `Write a value into the turn-scoped scratchpad - a shared key-value store accessible to the current agent and all its sub-agents.

Use the scratchpad to:
- Pass intermediate results between a main agent and sub-agents without bloating the main conversation context.
- Checkpoint long task progress so a second sub-agent can pick up where the first left off.
- Aggregate parallel sub-agent outputs before a final synthesis step.

Limits: 256 KB per key, 8 MB total per turn, 64 keys maximum.
The scratchpad is automatically deleted when the turn ends.`,

  inputSchema: writeSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
    internalPathCapability: 'turnScratchpad',
  },

  async execute(input, ctx, scope) {
    const { value, bytes } = await writeScratchpadEntry({
      dir: requireDir(scope),
      key: input.key,
      value: input.value,
      append: input.append ?? false,
      author: scope.scratchpadAuthor ?? 'main',
      signal: ctx.signal,
    });
    const estimatedTokens = estimateTextTokens(value);
    return { key: input.key, bytes, estimatedTokens };
  },
});

// ── ScratchpadRead ────────────────────────────────────────────────────────────

const readSchema = z.object({
  key: KEY_SCHEMA.describe('Identifier of the entry to read.'),
});

export const ScratchpadReadTool = buildTool<
  z.infer<typeof readSchema>,
  { value: string; bytes: number; estimatedTokens: number } | { value: null }
>({
  id: BuiltinTools.ScratchpadRead.id,
  name: BuiltinTools.ScratchpadRead.name,
  description:
    'Read a value from the turn-scoped scratchpad by key. ' +
    'Returns null when the key has not been written yet.',

  inputSchema: readSchema,
  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
    internalPathCapability: 'turnScratchpad',
  },

  async execute(input, _ctx, scope) {
    const value = await readScratchpadEntry(requireDir(scope), input.key);
    if (value === null) return { value: null };
    return {
      value,
      bytes:          Buffer.byteLength(value, 'utf8'),
      estimatedTokens: estimateTextTokens(value),
    };
  },
});

// ── ScratchpadList ────────────────────────────────────────────────────────────

export const ScratchpadListTool = buildTool<
  Record<never, never>,
  { keys: Array<{ key: string; bytes: number; estimatedTokens: number; author: string }>; totalBytes: number }
>({
  id: BuiltinTools.ScratchpadList.id,
  name: BuiltinTools.ScratchpadList.name,
  description:
    'List all keys currently stored in the turn-scoped scratchpad, with their sizes, ' +
    'token estimates, and which agent wrote them. ' +
    'Use this before reading to discover what sub-agents have written.',

  inputSchema: z.object({}),
  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
    internalPathCapability: 'turnScratchpad',
  },

  async execute(_input, _ctx, scope) {
    const entries = await listScratchpadEntries(requireDir(scope));
    const keys = entries.map(({ key, bytes, author }) => ({
      key,
      bytes,
      // 基于字节估算；读取单个 key 时再计算精确文本 token。
      estimatedTokens: Math.ceil(bytes / 4),
      author,
    }));

    const totalBytes = keys.reduce((s, e) => s + e.bytes, 0);
    return { keys, totalBytes };
  },
});

// ── ScratchpadDelete ──────────────────────────────────────────────────────────

const deleteSchema = z.object({
  key: KEY_SCHEMA.describe('Key to delete. No-op if the key does not exist.'),
});

export const ScratchpadDeleteTool = buildTool<z.infer<typeof deleteSchema>, { deleted: boolean }>({
  id: BuiltinTools.ScratchpadDelete.id,
  name: BuiltinTools.ScratchpadDelete.name,
  description:
    'Delete a single key from the turn-scoped scratchpad. ' +
    'Use this to free quota after a sub-agent\'s output has been consumed.',

  inputSchema: deleteSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
    internalPathCapability: 'turnScratchpad',
  },

  async execute(input, _ctx, scope) {
    return { deleted: await deleteScratchpadEntry(requireDir(scope), input.key) };
  },
});

// ── ScratchpadClear ───────────────────────────────────────────────────────────

export const ScratchpadClearTool = buildTool<Record<never, never>, { cleared: number }>({
  id: BuiltinTools.ScratchpadClear.id,
  name: BuiltinTools.ScratchpadClear.name,
  description:
    'Delete every key in the turn-scoped scratchpad and reset the quota to zero. ' +
    'Use this when intermediate working state is no longer needed and you want a clean slate ' +
    'before writing the final result, or to free space when approaching the 8 MB total limit.',

  inputSchema: z.object({}),
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
    internalPathCapability: 'turnScratchpad',
  },

  async execute(_input, _ctx, scope) {
    return { cleared: await clearScratchpad(requireDir(scope)) };
  },
});
