// 把完整文本安全地写入文件，并同步后续编辑所需的文件状态。
// 模型说明书见 prompt.ts; 补丁生成复用 FileEditTool/patch.ts。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  contentHashOf,
  contextFail,
  contextOk,
  type ReadFileState,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { atomicTransformUtf8 } from './atomicWrite.js';
import { isBlockedDevice } from '../FileReadTool/FileReadTool.js';
import { buildStructuredPatch, type PatchHunk } from '../FileEditTool/patch.js';
import { FILE_WRITE_DESCRIPTION } from './prompt.js';

/** File 写入工具只取得当前 Turn 的读取状态与工作区;取消与调用身份走 ToolInvocation。 */
interface FileWriteToolContext {
  readFileState: ReadFileState;
  workspaceRoot: string;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path to write. Created if it does not exist.'),
  content: z.string().describe('Full content to write. Replaces the existing file entirely.'),
});

type FileWriteInput = z.infer<typeof inputSchema>;

// ── 输出类型(与 Claude FileWrite Output 同构;差集:无 gitDiff) ─────────────────

export interface FileWriteResult {
  type: 'created' | 'updated';
  filePath: string;
  bytesWritten: number;
  /** 写入全文;created 形态的 UI 展示与审计基准。 */
  content: string;
  /** updated 的前文;created 为 null。 */
  originalFile: string | null;
  /** updated 的 diff;created 为空数组(UI 用 content 直接展示,不合成假 diff)。 */
  structuredPatch: PatchHunk[];
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileWriteTool = buildTool<FileWriteInput, FileWriteResult, FileWriteToolContext>({
  id: BuiltinTools.FileWrite.id,
  name: BuiltinTools.FileWrite.name,
  description: FILE_WRITE_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('File 写入工具需要明确的工作区。');
    }
    if (!ctx.readFileState) {
      return contextFail('File 写入工具未装配读取状态。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
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
    invocation: ToolInvocation,
  ): Promise<FileWriteResult> {
    const { file_path, content } = input;
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
      invocation.toolCallId,
      invocation.signal,
      current => {
        if (!current.existed) return content;
        const cached = context.readFileState.get(fullPath);
        if (!cached || cached.isPartialView) {
          throw new Error(
            `Write requires an existing file to be read in full first. ` +
              `Call Read("${file_path}") without offset/limit before overwriting it.`,
          );
        }
        // current.existed 已保证内容非空;空守卫仅为类型收窄。
        if (current.content === null || contentHashOf(current.content) !== cached.contentHash) {
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
      contentHash: contentHashOf(content),
      timestamp: mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      truncated: false,
    });
    const existed = written.existed;
    return {
      type: existed ? 'updated' : 'created',
      filePath: file_path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      content,
      originalFile: written.previousContent,
      structuredPatch: existed && written.previousContent !== null
        ? buildStructuredPatch(file_path, written.previousContent, content)
        : [],
    };
  },

  mapResultToModelContent(output) {
    if (output.type === 'created') {
      return `File created successfully at: ${output.filePath}`;
    }
    return `The file ${output.filePath} has been updated successfully.`;
  },
});
