
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type Scratchpad,
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

/** key 必须在所有平台(Windows + POSIX)作文件名安全. */
const KEY_SCHEMA = z.string().regex(
  SCRATCHPAD_KEY_RE,
  'Key must be 1-64 characters: letters, digits, _ or -',
);

interface ScratchpadToolContext {
  scratchpad: Scratchpad;
}

/** 缺少 Turn 临时目录时调用失败; 主 Agent 与子 Agent 共享这份目录. */
function validateScratchpad(ctx: ToolUseContext) {
  if (!ctx.scratchpad) {
    return contextFail('Scratchpad 未装配, 当前 Turn 没有临时目录.');
  }
  return contextOk<ScratchpadToolContext>({ scratchpad: ctx.scratchpad });
}

// Turn 内部目录, 无用户授权对象: key 受 KEY_SCHEMA 约束, 落在 scratchpad.dir 内, 直接放行.
const scratchpadAllow = async () => ({ kind: 'tool' as const, defaultDecision: 'allow' as const });

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

export const ScratchpadListTool = buildTool<
  Record<never, never>,
  { keys: Array<{ key: string; bytes: number; estimatedTokens: number; author: string }>; totalBytes: number },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadList.id,
  name: BuiltinTools.ScratchpadList.name,
  description: SCRATCHPAD_LIST_DESCRIPTION,

  inputSchema: z.object({}),
  isConcurrencySafe: () => true,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(_input, context) {
    const entries = await listScratchpadEntries(context.scratchpad.dir);
    const keys = entries.map(({ key, bytes, author }) => ({
      key,
      bytes,
      // 列表不读取正文, 这里只按字节近似; 读取单个 key 时再按文本估算.
      estimatedTokens: Math.ceil(bytes / 4),
      author,
    }));

    const totalBytes = keys.reduce((s, e) => s + e.bytes, 0);
    return { keys, totalBytes };
  },
});

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
  isConcurrencySafe: () => false,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(input, context) {
    return { deleted: await deleteScratchpadEntry(context.scratchpad.dir, input.key) };
  },
});

export const ScratchpadClearTool = buildTool<
  Record<never, never>,
  { cleared: number },
  ScratchpadToolContext
>({
  id: BuiltinTools.ScratchpadClear.id,
  name: BuiltinTools.ScratchpadClear.name,
  description: SCRATCHPAD_CLEAR_DESCRIPTION,

  inputSchema: z.object({}),
  isConcurrencySafe: () => false,

  checkPermissions: scratchpadAllow,

  validateContext: validateScratchpad,

  async execute(_input, context) {
    return { cleared: await clearScratchpad(context.scratchpad.dir) };
  },
});
