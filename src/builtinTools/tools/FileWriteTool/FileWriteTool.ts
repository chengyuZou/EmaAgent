// 把完整文本安全地写入文件，并同步后续编辑所需的文件状态。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type BuiltinToolContext,
  type ReadFileState,
} from '@ema-agent/tools';
import type { ToolCallId } from '@ema-agent/ids';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { atomicTransformUtf8 } from './atomicWrite.js';
import { isBlockedDevice } from '../FileReadTool/FileReadTool.js';

/** File 写入工具只取得当前 Turn 的写入保护状态和单次调用身份。 */
interface FileWriteToolContext {
  readFileState: ReadFileState;
  signal: AbortSignal;
  toolCallId: ToolCallId;
  workspaceRoot: string;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to write. Created if it does not exist.'),
  content: z.string().describe('Full content to write. Replaces the existing file entirely.'),
});

type FileWriteInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface FileWriteResult {
  type: 'created' | 'updated';
  filePath: string;
  bytesWritten: number;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileWriteTool = buildTool<FileWriteInput, FileWriteResult, BuiltinToolContext, FileWriteToolContext>({
  id: BuiltinTools.FileWrite.id,
  name: BuiltinTools.FileWrite.name,
  description: `Write full content to a file, creating it if it does not exist.

- Replaces the entire file - for targeted in-place edits use \`Edit\` instead.
- An existing file MUST have been read in full with \`Read\` before it can be overwritten.
- Parent directories are created automatically.
- Paths are resolved against the session workspace (absolute paths are used as-is).
- Line endings in \`content\` are written as-is (LF preserved, no rewriting).
- After writing, the file is added to the read-state cache so subsequent \`Edit\` calls work without a separate read.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  requires: ['workspaceRoot', 'readFileState'],

  validateContext(ctx) {
    if (!ctx.workspaceRoot || !ctx.readFileState || !ctx.toolCallId) {
      return contextFail('File 写入工具未装配完整的工作区、读取状态或调用身份。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
      signal: ctx.signal,
      toolCallId: ctx.toolCallId,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  getPermissionIntent: (input) => ({
    riskLevel: 'medium',
    accessType: 'write',
    targets: [{ path: input.file_path, accessType: 'write' }],
    promptPolicy: 'whenRequired',
  }),

  async execute(
    input: FileWriteInput,
    context: FileWriteToolContext,
  ): Promise<FileWriteResult> {
    const { file_path, content } = input;
    const operationId = context.toolCallId;
    // 与 Permission/Read 同一基准: 相对路径按工作区解析, 不借 Core 进程 cwd——
    // 否则审批查的是工作区路径, 实际写的却是 Core 启动目录(P1 路径分裂)。
    const fullPath = path.resolve(context.workspaceRoot, file_path);

    // ── I/O 前守卫(与 Read 对称, 写比读更危险) ────────────────────────────────
    if (fullPath.startsWith('\\\\')) {
      throw new Error(`UNC paths are not supported: ${fullPath}`);
    }
    if (isBlockedDevice(fullPath)) {
      throw new Error(`Writing to device file is not allowed: ${fullPath}`);
    }
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${fullPath}`);
    }

    const written = await atomicTransformUtf8(
      fullPath,
      operationId,
      context.signal,
      current => {
        if (!current.existed) return content;
        const cached = context.readFileState.get(fullPath);
        if (!cached || cached.isPartialView) {
          throw new Error(
            `Write requires an existing file to be read in full first. ` +
              `Call Read("${file_path}") without offset/limit before overwriting it.`,
          );
        }
        if (current.content !== cached.content) {
          throw new Error(
            `File "${file_path}" was modified externally since it was read. ` +
              'Re-read it with Read before overwriting it.',
          );
        }
        return content;
      },
    );
    const mtimeMs = written.mtimeMs;

    // 更新 read-state 缓存，使后续 Edit 无需重新读取即可工作。
    context.readFileState.set(fullPath, {
      content,
      timestamp: mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      truncated: false,
    });
    return {
      type: written.existed ? 'updated' : 'created',
      filePath: file_path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
  },
});
