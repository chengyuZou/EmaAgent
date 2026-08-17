// 在已读取的文件中执行受保护的精确文本替换。
// 模型说明书见 prompt.ts; 文本匹配见 textMatch.ts; 补丁生成见 patch.ts。
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
import { atomicTransformUtf8 } from '../FileWriteTool/atomicWrite.js';
import { buildStructuredPatch, type PatchHunk } from './patch.js';
import { FILE_EDIT_DESCRIPTION } from './prompt.js';
import {
  countOccurrences,
  findActualString,
  preserveQuoteStyle,
  stripTrailingWhitespace,
} from './textMatch.js';

/** File 编辑工具只取得当前 Turn 的读取状态与工作区;取消与调用身份走 ToolInvocation。 */
interface FileEditToolContext {
  readFileState: ReadFileState;
  workspaceRoot: string;
}

/** 编辑文件大小上限,防 V8 字符串长度限制(~2^30)导致 OOM。 */
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('Absolute path to the file to edit. Must have been read with Read first.'),
  old_string: z.string().min(1).describe('Exact non-empty string to find and replace. Must be unique in the file.'),
  new_string: z.string().describe('Replacement string (must differ from old_string).'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring uniqueness.'),
});

type FileEditInput = z.infer<typeof inputSchema>;

// ── 输出类型(与 Claude FileEditOutput 同构;差集:无 userModified/gitDiff) ──────

export interface FileEditResult {
  filePath: string;
  /** 实际被替换的子串(引号归一化后的文件原文)。 */
  oldString: string;
  /** 实际写入的子串(引号风格保持后)。 */
  newString: string;
  /** 编辑前全文,审计与重算的基准。 */
  originalFile: string;
  structuredPatch: PatchHunk[];
  replaceAll: boolean;
  replacements: number;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileEditTool = buildTool<FileEditInput, FileEditResult, FileEditToolContext>({
  id: BuiltinTools.FileEdit.id,
  name: BuiltinTools.FileEdit.name,
  description: FILE_EDIT_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  validateContext(ctx) {
    if (!ctx.workspaceRoot) {
      return contextFail('File 编辑工具需要明确的工作区。');
    }
    if (!ctx.readFileState) {
      return contextFail('File 编辑工具未装配读取状态。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
      workspaceRoot: ctx.workspaceRoot,
    });
  },

  validateInput(input) {
    // 空操作 edit 在准备阶段直接拒绝,避免产生假变更。
    if (input.old_string === input.new_string) {
      return {
        valid: false,
        message: 'old_string 与 new_string 相同;空编辑不允许。若要查看文件用 Read,若要改请给出不同的 new_string。',
        code: 'edit/empty',
        retryable: true,
      };
    }
    return { valid: true };
  },

  getPermissionIntent: (input) => ({
    riskLevel: 'medium',
    accessType: 'write',
    targets: [{ path: input.file_path, accessType: 'write' }],
    promptPolicy: 'whenRequired',
  }),

  async execute(
    input: FileEditInput,
    context: FileEditToolContext,
    invocation: ToolInvocation,
  ): Promise<FileEditResult> {
    const { file_path, old_string, replace_all } = input;
    // 与 FileRead/Permission 同一基准: 相对路径按工作区解析, 不借宿主进程 cwd。
    const fullPath = path.resolve(context.workspaceRoot, file_path);

    // ── 文件大小上限(防 V8 字符串长度 OOM)─────────────────────────────────
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      throw new Error(`File no longer exists: ${file_path}`);
    }
    if (stat.size > MAX_EDIT_FILE_SIZE) {
      throw new Error(
        `File is too large to edit (${(stat.size / 1024 / 1024).toFixed(1)} MiB > ${MAX_EDIT_FILE_SIZE / 1024 / 1024} MiB).`,
      );
    }

    // ── 必须先读守卫 ─────────────────────────────────────────────────────────
    const cached = context.readFileState.get(fullPath);
    if (!cached) {
      throw new Error(
        `Edit requires the file to be read first. Call Read("${file_path}") before editing.`,
      );
    }
    if (cached.isPartialView) {
      throw new Error(
        `Edit requires a full read of the file. The cached view of "${file_path}" is partial ` +
          `(offset/limit was used). Call Read("${file_path}") without offset/limit first.`,
      );
    }

    // ── new_string 预处理:尾部空白裁剪(Markdown 保留硬换行)─────────────────
    const isMarkdown = /\.(md|mdx)$/i.test(file_path);
    const newString = isMarkdown ? input.new_string : stripTrailingWhitespace(input.new_string);

    let actualOld = '';
    let styledNew = '';
    let replacements = 0;
    const written = await atomicTransformUtf8(
      fullPath,
      invocation.toolCallId,
      invocation.signal,
      current => {
        if (!current.existed || current.content === null || current.mtimeMs === null) {
          throw new Error(`File no longer exists: ${file_path}`);
        }

        // 外部修改检测：内容指纹(sha256)与缓存基准比对——内容变必哈希变，与 mtime 无关；
        // 只改 mtime 不改内容(云同步/杀软触碰)哈希不变，照常放行，不误报。
        if (contentHashOf(current.content) !== cached.contentHash) {
          throw new Error(
            `File "${file_path}" was modified externally since it was read. ` +
              'Re-read it with Read before editing.',
          );
        }

        const actual = findActualString(current.content, old_string);
        if (actual === null) {
          throw new Error(
            `The string to replace was not found in "${file_path}".\n\n` +
              `old_string:\n${old_string}\n\n` +
              'Verify the exact text by re-reading the file.',
          );
        }

        const occurrences = countOccurrences(current.content, actual);
        if (!replace_all && occurrences > 1) {
          throw new Error(
            `The string to replace appears ${occurrences} times in "${file_path}". ` +
              'Provide more context to make it unique, or set replace_all: true.',
          );
        }
        replacements = replace_all ? occurrences : 1;
        actualOld = actual;
        // 文件用弯引号时把 newString 直引号转回弯引号,保持排版风格
        styledNew = preserveQuoteStyle(actual, newString);
        // 删除场景:连同紧跟换行一起删,避免留空行
        if (styledNew === '' && !actual.endsWith('\n') && current.content.includes(actual + '\n')) {
          return current.content.split(actual + '\n').join('');
        }
        return replace_all
          ? current.content.split(actual).join(styledNew)
          : current.content.replace(actual, styledNew);
      },
      false,
    );

    // 用编辑后内容更新缓存,后续 Read/Edit 命中新版本。
    // contentHash 一并刷新,使下一次 Edit 的"外部修改"检测基准滚动到本次落盘状态。
    context.readFileState.set(fullPath, {
      content: written.content,
      contentHash: contentHashOf(written.content),
      timestamp: written.mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      truncated: false,
    });

    return {
      filePath: file_path,
      oldString: actualOld,
      newString: styledNew,
      originalFile: written.previousContent ?? '',
      structuredPatch: buildStructuredPatch(
        file_path,
        written.previousContent ?? '',
        written.content,
      ),
      replaceAll: replace_all,
      replacements,
    };
  },

  mapResultToModelContent(output) {
    if (output.replaceAll) {
      return `The file ${output.filePath} has been updated. `
        + `All ${output.replacements} occurrences were successfully replaced.`;
    }
    return `The file ${output.filePath} has been updated successfully.`;
  },
});
