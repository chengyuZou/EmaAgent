// 提供当前 Turn 内主 Agent 和子 Agent 共用的临时 KV 读写工具。
// 五件套共享同一窄 Context 与 key 约束,体量微小,按家族单文件内聚,不拆碎文件。

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ScratchpadPort,
  type ToolUseContext,
} from '@ema-agent/tools';
import { estimateTextTokens } from '@ema-agent/token';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import {
  clearScratchpad,
  deleteScratchpadEntry,
  listScratchpadEntries,
  readScratchpadEntry,
  SCRATCHPAD_KEY_RE,
  writeScratchpadEntry,
} from './ScratchpadStore.js';
import {
  SCRATCHPAD_CLEAR_DESCRIPTION,
  SCRATCHPAD_DELETE_DESCRIPTION,
  SCRATCHPAD_LIST_DESCRIPTION,
  SCRATCHPAD_READ_DESCRIPTION,
  SCRATCHPAD_WRITE_DESCRIPTION,
} from './prompt.js';

// ── 约束与窄 Context ───────────────────────────────────────────────────────────

/** key 必须在所有平台(Windows + POSIX)作文件名安全。 */
const KEY_SCHEMA = z.string().regex(
  SCRATCHPAD_KEY_RE,
  'Key must be 1–64 characters: letters, digits, _ or -',
);

/** Scratchpad 工具族的窄 Context:只有 Turn 级存储位置;取消信号由 ToolInvocation 提供。 */
interface ScratchpadToolContext {
  scratchpad: ScratchpadPort;
}

/** 五件套共用:scratchpad 必须装配(仅 work Turn),否则工具不可见。 */
function validateScratchpad(ctx: ToolUseContext) {
  if (!ctx.scratchpad) {
    return contextFail('Scratchpad 未装配(仅 work Turn 可用)。');
  }
  return contextOk<ScratchpadToolContext>({ scratchpad: ctx.scratchpad });
}

// Turn 内部目录, 无用户授权对象: key 受 KEY_SCHEMA 约束, 落在 scratchpad.dir 内, 直接放行。
const scratchpadAllow: () => Promise<{ behavior: 'allow' }> = async () => ({ behavior: 'allow' });

// ── ScratchpadWrite ───────────────────────────────────────────────────────────

const writeSchema = z.object({
  key: KEY_SCHEMA.describe(
    'Identifier for this scratchpad entry. Use a descriptive name like "research_summary" or "task_result_2".',
  ),
  value: z.string().describe(
    'Text content to store. Overwrites any existing value for this key.',
  ),
  append: z.boolean().optional().describe(
    'When true, appends value to any existing content (with a newline separator) instead of overwriting.',
  ),
});

export const ScratchpadWriteTool = buildTool<
  z.infer<typeof writeSchema>,
  { key: string; bytes: number; estimatedTokens: number },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadWrite.id,
  name: BuiltinTools.ScratchpadWrite.name,
  description: SCRATCHPAD_WRITE_DESCRIPTION,

  inputSchema: writeSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(input, context, invocation) {
    const { value, bytes } = await writeScratchpadEntry({
      dir: context.scratchpad.dir,
      key: input.key,
      value: input.value,
      append: input.append ?? false,
      author: context.scratchpad.author,
      signal: invocation.signal,
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
  { value: string; bytes: number; estimatedTokens: number } | { value: null },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadRead.id,
  name: BuiltinTools.ScratchpadRead.name,
  description: SCRATCHPAD_READ_DESCRIPTION,

  inputSchema: readSchema,
  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(input, context) {
    const value = await readScratchpadEntry(context.scratchpad.dir, input.key);
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
  { keys: Array<{ key: string; bytes: number; estimatedTokens: number; author: string }>; totalBytes: number },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadList.id,
  name: BuiltinTools.ScratchpadList.name,
  description: SCRATCHPAD_LIST_DESCRIPTION,

  inputSchema: z.object({}),
  isReadOnly:        () => true,
  isConcurrencySafe: () => true,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(_input, context) {
    const entries = await listScratchpadEntries(context.scratchpad.dir);
    const keys = entries.map(({ key, bytes, author }) => ({
      key,
      bytes,
      // 基于字节估算;读取单个 key 时再计算精确文本 token。
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

export const ScratchpadDeleteTool = buildTool<
  z.infer<typeof deleteSchema>,
  { deleted: boolean },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadDelete.id,
  name: BuiltinTools.ScratchpadDelete.name,
  description: SCRATCHPAD_DELETE_DESCRIPTION,

  inputSchema: deleteSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(input, context) {
    return { deleted: await deleteScratchpadEntry(context.scratchpad.dir, input.key) };
  },
});

// ── ScratchpadClear ───────────────────────────────────────────────────────────

export const ScratchpadClearTool = buildTool<
  Record<never, never>,
  { cleared: number },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadClear.id,
  name: BuiltinTools.ScratchpadClear.name,
  description: SCRATCHPAD_CLEAR_DESCRIPTION,

  inputSchema: z.object({}),
  isReadOnly:        () => false,
  isConcurrencySafe: () => false,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(_input, context) {
    return { cleared: await clearScratchpad(context.scratchpad.dir) };
  },
});
