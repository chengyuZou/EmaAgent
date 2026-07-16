// 这里提供当前 Turn 内主 Agent 和子 Agent 共用的临时读写工具。

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { estimateTextTokens } from '@ema-agent/token';

// ── 约束 ───────────────────────────────────────────────────────────────────────

/** key 必须在所有平台(Windows + POSIX)作文件名安全。 */
export const KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const KEY_SCHEMA = z.string().regex(KEY_RE, 'Key must be 1–64 characters: letters, digits, _ or -');

const MAX_VALUE_BYTES   = 256 * 1024;         // 每值 256 KB
const MAX_TOTAL_BYTES   = 8 * 1024 * 1024;    // 每 turn 总共 8 MB
const MAX_KEYS          = 64;                  // 防止 key 爆炸

/** 隐藏元数据文件 - 点前缀让它在 KEY_RE 过滤里不可见。 */
const META_FILE = '.meta.json';

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function requireDir(ctx: ToolExecutionContext): string {
  if (!ctx.scratchpadDir) {
    throw new Error(
      'Scratchpad is not available in this context. ' +
      'It is only enabled during agent-mode turns with a configured data directory.',
    );
  }
  return ctx.scratchpadDir;
}

function keyPath(dir: string, key: string): string {
  return path.join(dir, key);
}

/** 返回所有现有 key 占用的总字节。 */
function totalBytesUsed(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir)
    .filter(f => KEY_RE.test(f))
    .reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
    }, 0);
}

/** 返回现有有效 key 数。 */
function keyCount(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => KEY_RE.test(f)).length;
}

// ── 作者元数据 ───────────────────────────────────────────────────────────────────

type MetaStore = Record<string, { author: string }>;

function readMeta(dir: string): MetaStore {
  const fp = path.join(dir, META_FILE);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')) as MetaStore; } catch { return {}; }
}

function writeMeta(dir: string, key: string, author: string): void {
  const meta = readMeta(dir);
  meta[key] = { author };
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta), 'utf8');
}

function clearMeta(dir: string): void {
  const fp = path.join(dir, META_FILE);
  if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
}

// ── scratchpad_write ──────────────────────────────────────────────────────────

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

export const scratchpadWriteTool = buildTool<
  z.infer<typeof writeSchema>,
  { key: string; bytes: number; estimatedTokens: number }
>({
  name: 'scratchpad_write',
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

  async execute(input, ctx) {
    const dir = requireDir(ctx);

    // 字节级大小检查(非字符数 - 抓多字节 Unicode)
    const incomingBytes = Buffer.byteLength(input.value, 'utf8');
    if (incomingBytes > MAX_VALUE_BYTES) {
      throw new Error(
        `Value too large: ${formatBytes(incomingBytes)} (max ${formatBytes(MAX_VALUE_BYTES)} per key). ` +
        'Consider splitting into multiple keys or summarising first.',
      );
    }

    // 总配额检查
    const existingSize = fs.existsSync(keyPath(dir, input.key))
      ? fs.statSync(keyPath(dir, input.key)).size
      : 0;
    const projectedTotal = totalBytesUsed(dir) - existingSize + incomingBytes;
    if (projectedTotal > MAX_TOTAL_BYTES) {
      throw new Error(
        `Turn scratchpad quota exceeded: writing this value would use ${formatBytes(projectedTotal)} ` +
        `(max ${formatBytes(MAX_TOTAL_BYTES)}). Delete unused keys first.`,
      );
    }

    // Key 数量守卫(仅新 key)
    if (!fs.existsSync(keyPath(dir, input.key)) && keyCount(dir) >= MAX_KEYS) {
      throw new Error(
        `Too many scratchpad keys (max ${MAX_KEYS}). Delete keys you no longer need.`,
      );
    }

    fs.mkdirSync(dir, { recursive: true });

    let finalValue = input.value;
    if (input.append) {
      const existing = fs.existsSync(keyPath(dir, input.key))
        ? fs.readFileSync(keyPath(dir, input.key), 'utf8')
        : '';
      finalValue = existing ? existing + '\n' + input.value : input.value;

      // append 后重检
      const appendedBytes = Buffer.byteLength(finalValue, 'utf8');
      if (appendedBytes > MAX_VALUE_BYTES) {
        throw new Error(
          `Appended value would be ${formatBytes(appendedBytes)}, exceeding the ${formatBytes(MAX_VALUE_BYTES)} per-key limit.`,
        );
      }
    }

    fs.writeFileSync(keyPath(dir, input.key), finalValue, 'utf8');

    // 记录哪个 agent 写了此 key
    writeMeta(dir, input.key, ctx.scratchpadAuthor ?? 'main');

    const bytes          = Buffer.byteLength(finalValue, 'utf8');
    const estimatedTokens = estimateTextTokens(finalValue);
    return { key: input.key, bytes, estimatedTokens };
  },
});

// ── scratchpad_read ───────────────────────────────────────────────────────────

const readSchema = z.object({
  key: KEY_SCHEMA.describe('Identifier of the entry to read.'),
});

export const scratchpadReadTool = buildTool<
  z.infer<typeof readSchema>,
  { value: string; bytes: number; estimatedTokens: number } | { value: null }
>({
  name: 'scratchpad_read',
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

  async execute(input, ctx) {
    const dir = requireDir(ctx);
    const fp  = keyPath(dir, input.key);
    if (!fs.existsSync(fp)) return { value: null };

    const value = fs.readFileSync(fp, 'utf8');
    return {
      value,
      bytes:          Buffer.byteLength(value, 'utf8'),
      estimatedTokens: estimateTextTokens(value),
    };
  },
});

// ── scratchpad_list ───────────────────────────────────────────────────────────

export const scratchpadListTool = buildTool<
  Record<never, never>,
  { keys: Array<{ key: string; bytes: number; estimatedTokens: number; author: string }>; totalBytes: number }
>({
  name: 'scratchpad_list',
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

  async execute(_input, ctx) {
    const dir = requireDir(ctx);
    if (!fs.existsSync(dir)) return { keys: [], totalBytes: 0 };

    const meta = readMeta(dir);

    const keys = fs.readdirSync(dir)
      .filter(f => KEY_RE.test(f))
      .map(f => {
        try {
          const filePath = path.join(dir, f);
          const bytes    = fs.statSync(filePath).size;
          // 基于字节的 token 估算,避免为每个 key 读文件内容。
          // ~4 字节/token 对此处存的混合内容是安全近似。
          // 用 scratchpad_read 取特定 key 的精确计数。
          return {
            key:            f,
            bytes,
            estimatedTokens: Math.ceil(bytes / 4),
            author:         meta[f]?.author ?? 'main',
          };
        } catch {
          return { key: f, bytes: 0, estimatedTokens: 0, author: meta[f]?.author ?? 'main' };
        }
      });

    const totalBytes = keys.reduce((s, e) => s + e.bytes, 0);
    return { keys, totalBytes };
  },
});

// ── scratchpad_delete ─────────────────────────────────────────────────────────

const deleteSchema = z.object({
  key: KEY_SCHEMA.describe('Key to delete. No-op if the key does not exist.'),
});

export const scratchpadDeleteTool = buildTool<z.infer<typeof deleteSchema>, { deleted: boolean }>({
  name: 'scratchpad_delete',
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

  async execute(input, ctx) {
    const dir = requireDir(ctx);
    const fp  = keyPath(dir, input.key);
    if (!fs.existsSync(fp)) return { deleted: false };
    fs.rmSync(fp, { force: true });

    // 从元数据移除
    const meta = readMeta(dir);
    if (input.key in meta) {
      delete meta[input.key];
      fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta), 'utf8');
    }

    return { deleted: true };
  },
});

// ── scratchpad_clear_all ──────────────────────────────────────────────────────

export const scratchpadClearAllTool = buildTool<Record<never, never>, { cleared: number }>({
  name: 'scratchpad_clear_all',
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

  async execute(_input, ctx) {
    const dir = requireDir(ctx);
    if (!fs.existsSync(dir)) return { cleared: 0 };

    const keys = fs.readdirSync(dir).filter(f => KEY_RE.test(f));
    for (const f of keys) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best-effort */ }
    }
    clearMeta(dir);
    return { cleared: keys.length };
  },
});

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024)            return `${n} B`;
  if (n < 1024 * 1024)    return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
