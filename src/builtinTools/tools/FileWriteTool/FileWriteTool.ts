// 把完整文本安全地写入文件，并同步后续编辑所需的文件状态。
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  createFileChangePresentation,
  presentToolResult,
} from '@ema-agent/tools';
import type { FileStateStore, ReadFileState } from '@ema-agent/tools';
import type { ToolCallId } from '@ema-agent/ids';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';
import { atomicTransformUtf8 } from './atomicWrite.js';

/** File 写入工具的窄 Context：去重缓存 + 可选持久状态 + per-call 身份。 */
interface FileWriteToolContext {
  readFileState: ReadFileState;
  fileStateStore?: FileStateStore;
  signal: AbortSignal;
  toolCallId: ToolCallId;
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
      ...(ctx.fileStateStore ? { fileStateStore: ctx.fileStateStore } : {}),
      signal: ctx.signal,
      toolCallId: ctx.toolCallId,
    });
  },

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'write',
    extractPath: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      return parsed.success ? parsed.data.file_path : undefined;
    },
  },

  async execute(
    input: FileWriteInput,
    context: FileWriteToolContext,
  ): Promise<FileWriteResult> {
    const { file_path, content } = input;
    const operationId = context.toolCallId;
    const readStatePath = path.resolve(file_path);
    const written = await atomicTransformUtf8(
      file_path,
      operationId,
      context.signal,
      current => {
        if (!current.existed) return content;
        const cached = context.readFileState.get(readStatePath);
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
    const fullPath = readStatePath;
    const mtimeMs = written.mtimeMs;

    // 更新 read-state 缓存，使后续 Edit 无需重新读取即可工作。
    context.readFileState.set(fullPath, {
      content,
      timestamp: mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });
    context.fileStateStore?.record(fullPath, {
      content,
      mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });

    return presentToolResult({
      type: written.existed ? 'updated' : 'created',
      filePath: file_path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    }, createFileChangePresentation(file_path, written.previousContent, written.content));
  },
});
