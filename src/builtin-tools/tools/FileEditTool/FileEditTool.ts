// 在已读取的文件中执行受保护的精确文本替换。
// 模型说明书见 prompt.ts; 文本匹配见 textMatch.ts; 补丁生成见 patch.ts。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { filePathToRuleContent } from '@ema-agent/permission';
import type { StructuredPatchHunk } from 'diff';
import {
  buildTool,
  fileChangedSinceRead,
  contextFail,
  contextOk,
  type FileStateCache,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { checkWritePathPermission } from '../shared/pathPermission.js';
import { atomicTransformUtf8 } from '../FileWriteTool/atomicWrite.js';
import { buildStructuredPatch, countPatchLines } from './patch.js';
import { FILE_EDIT_DESCRIPTION } from './prompt.js';
import {
  countOccurrences,
  findActualString,
  preserveQuoteStyle,
  stripTrailingWhitespace,
} from './textMatch.js';

interface FileEditToolContext {
  fileStateCache: FileStateCache;
  cwd: string;
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

export interface FileEditResult {
  filePath: string;
  /** 实际被替换的子串 */
  oldString: string;
  /** 实际写入的子串 */
  newString: string;
  /** 编辑前全文,审计与重算的基准。 */
  originalFile: string;
  structuredPatch: StructuredPatchHunk[];
  /** 本次 Tool 调用在 structuredPatch 中新增的行数. */
  additions: number;
  /** 本次 Tool 调用在 structuredPatch 中删除的行数. */
  deletions: number;
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
    if (!ctx.cwd) {
      return contextFail('File 编辑工具需要明确的工作区。');
    }
    if (!ctx.fileStateCache) {
      return contextFail('File 编辑工具未装配读取状态。');
    }
    return contextOk({
      fileStateCache: ctx.fileStateCache,
      cwd: ctx.cwd,
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

  async checkPermissions(input, context, permissionContext) {
    const filePath = path.resolve(context.cwd, input.file_path);
    const result = checkWritePathPermission({
      toolName: BuiltinTools.FileEdit.name,
      path: filePath,
      cwd: context.cwd,
      permissionContext,
    });
    if (result.behavior === 'deny') {
      return result;
    }
    return {
      ...result,
      sessionAllowRule: {
        toolName: BuiltinTools.FileEdit.name,
        ruleContent: filePathToRuleContent(filePath),
      },
    };
  },

  async execute(
    input: FileEditInput,
    context: FileEditToolContext,
    invocation: ToolInvocation,
  ): Promise<FileEditResult> {
    const { file_path, old_string, replace_all } = input;
    // 与 FileRead/Permission 同一基准: 相对路径按工作区解析, 不借宿主进程 cwd。
    const fullPath = path.resolve(context.cwd, file_path);

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
    const cached = context.fileStateCache.get(fullPath);
    if (!cached) {
      throw new Error(
        `Edit requires the file to be read first. Call Read("${file_path}") before editing.`,
      );
    }

    // ── new_string 预处理:尾部空白裁剪(Markdown 保留硬换行)─────────────────
    const isMarkdown = /\.(md|mdx)$/i.test(file_path);
    const normalizedNew = input.new_string.replace(/\r\n/g, '\n');
    const newString = isMarkdown ? normalizedNew : stripTrailingWhitespace(normalizedNew);

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

        if (fileChangedSinceRead(cached, current.mtimeMs, current.content)) {
          throw new Error(
            `File "${file_path}" was modified externally since it was read. ` +
              'Re-read it with Read before editing.',
          );
        }

        const normalizedContent = current.content.replace(/\r\n/g, '\n');
        const actual = findActualString(normalizedContent, old_string.replace(/\r\n/g, '\n'));
        if (actual === null) {
          throw new Error(
            `The string to replace was not found in "${file_path}".\n\n` +
              `old_string:\n${old_string}\n\n` +
              'Verify the exact text by re-reading the file.',
          );
        }

        const occurrences = countOccurrences(normalizedContent, actual);
        if (!replace_all && occurrences > 1) {
          throw new Error(
            `The string to replace appears ${occurrences} times in "${file_path}". ` +
              'Provide more context to make it unique, or set replace_all: true.',
          );
        }
        replacements = replace_all ? occurrences : 1;
        // 文件用弯引号时把 newString 直引号转回弯引号,保持排版风格
        const replacement = preserveQuoteStyle(actual, newString);
        const usesCrlf = current.content.includes('\r\n');
        actualOld = usesCrlf ? actual.replace(/\n/g, '\r\n') : actual;
        styledNew = usesCrlf ? replacement.replace(/\n/g, '\r\n') : replacement;
        // 删除场景:连同紧跟换行一起删,避免留空行
        let updated: string;
        if (replacement === '' && !actual.endsWith('\n') && normalizedContent.includes(actual + '\n')) {
          updated = normalizedContent.split(actual + '\n').join('');
        } else if (replace_all) {
          updated = normalizedContent.split(actual).join(replacement);
        } else {
          updated = normalizedContent.replace(actual, replacement);
        }
        return usesCrlf ? updated.replace(/\n/g, '\r\n') : updated;
      },
      false,
    );

    // 用编辑后内容更新缓存,后续 Read/Edit 命中新版本。
    context.fileStateCache.set(fullPath, {
      content: written.content,
      timestamp: written.mtimeMs,
      offset: undefined,
      limit: undefined,
      totalLines: written.content.split('\n').length,
      truncated: false,
    });

    const structuredPatch = buildStructuredPatch(
      file_path,
      written.previousContent ?? '',
      written.content,
    );
    const { additions, deletions } = countPatchLines(structuredPatch);

    return {
      filePath: file_path,
      oldString: actualOld,
      newString: styledNew,
      originalFile: written.previousContent ?? '',
      structuredPatch,
      additions,
      deletions,
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
