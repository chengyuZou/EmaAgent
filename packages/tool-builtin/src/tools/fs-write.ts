// 这个内置工具负责把完整文本安全地写入文件，并同步后续编辑所需的文件状态。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { atomicWriteUtf8 } from '../files/atomic-write.js';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to write. Created if it does not exist.'),
  content: z.string().describe('Full content to write. Replaces the existing file entirely.'),
});

type FsWriteInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface FsWriteResult {
  type: 'created' | 'updated';
  filePath: string;
  bytesWritten: number;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const fsWriteTool = buildTool<FsWriteInput, FsWriteResult>({
  name: 'fs_write',
  description: `Write full content to a file, creating it if it does not exist.

- Replaces the entire file - for targeted in-place edits use \`fs_edit\` instead.
- Parent directories are created automatically.
- Line endings in \`content\` are written as-is (LF preserved, no rewriting).
- After writing, the file is added to the read-state cache so subsequent \`fs_edit\` calls work without a separate read.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'write',
    extractPath: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      return parsed.success ? parsed.data.file_path : undefined;
    },
  },

  async execute(input: FsWriteInput, ctx: ToolExecutionContext): Promise<FsWriteResult> {
    const { file_path, content } = input;
    const operationId = ctx.toolCallId ?? randomUUID();
    const written = await atomicWriteUtf8(file_path, content, operationId, ctx.signal);
    const fullPath = written.targetPath;
    const mtimeMs = written.mtimeMs;

    // 更新 read-state 缓存,使后续 fs_edit 无需重新读即可工作
    ctx.readFileState.set(fullPath, {
      content,
      timestamp: mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });
    ctx.fileStateStore?.record(fullPath, {
      content,
      mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });

    return {
      type: written.existed ? 'updated' : 'created',
      filePath: file_path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
  },
});
