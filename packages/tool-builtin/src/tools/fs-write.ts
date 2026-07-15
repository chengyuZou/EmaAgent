import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';

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
    const fullPath = path.resolve(file_path);

    const existed = fs.existsSync(fullPath);

    // 确保父目录存在
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // ── 原子写(write + rename 避免读到半成品文件)─────────────────
    // Windows 上 rename() 跨卷不原子,但同目录内是。rename 失败回退直接写。
    const tmpPath = `${fullPath}.ema_tmp_${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'w' });
      fs.renameSync(tmpPath, fullPath);
    } catch {
      // 清理临时文件并直接写
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      fs.writeFileSync(fullPath, content, { encoding: 'utf8', flag: 'w' });
    }

    const mtimeMs = fs.statSync(fullPath).mtimeMs;

    // 更新 read-state 缓存,使后续 fs_edit 无需重新读即可工作
    ctx.readFileState.set(fullPath, {
      content,
      timestamp: mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });

    return {
      type: existed ? 'updated' : 'created',
      filePath: file_path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
  },
});
