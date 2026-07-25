// 在已读取的文件中执行受保护的精确文本替换。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  buildTool,
  createFileChangePresentation,
  presentToolResult,
} from '@ema-agent/tools';
import type { ReadFileState } from '@ema-agent/tools';
import type { ToolCallId } from '@ema-agent/ids';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';
import { atomicTransformUtf8 } from '../FileWriteTool/atomicWrite.js';

/** File 编辑工具只取得当前 Turn 的写入保护状态和单次调用身份。 */
interface FileEditToolContext {
  readFileState: ReadFileState;
  signal: AbortSignal;
  toolCallId: ToolCallId;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('Absolute path to the file to edit. Must have been read with Read first.'),
  old_string: z.string().min(1).describe('Exact non-empty string to find and replace. Must be unique in the file.'),
  new_string: z.string().describe('Replacement string.'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring uniqueness.'),
});

type FileEditInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface FileEditResult {
  filePath: string;
  replacements: number;
}

// ── 引号归一化 ─────────────────────────────────────────────────────────────────

/** 把排版引号归一化为直 ASCII 等价物以便匹配。 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛′‵]/g, "'") // 单弯引号 -> '
    .replace(/[“”„‟″‶]/g, '"'); // 双弯引号 -> "
}

/**
 * 在 `fileContent` 中定位 `search`,先精确匹配,再引号归一化兜底。
 * 返回文件中的实际子串,以便替换用文件自己的引号风格。
 */
function findActualString(fileContent: string, search: string): string | null {
  if (fileContent.includes(search)) return search;

  // 精确匹配失败时归一化弯引号后定位;返回文件实际子串,替换用文件自己的引号风格。
  const normalizedSearch = normalizeQuotes(search);
  const normalizedFile = normalizeQuotes(fileContent);
  const found = normalizedFile.indexOf(normalizedSearch);
  if (found === -1) return null;
  return fileContent.substring(found, found + search.length);
}

/** 数 `haystack` 中 `needle` 的非重叠出现次数。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/** 编辑文件大小上限,防 V8 字符串长度限制(~2^30)导致 OOM。 */
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

/** 每行去尾部空白(空格/tab);Markdown 除外(行尾两空格是硬换行,裁剪改语义)。 */
function stripTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/gm, '');
}

/**
 * 文件 old_string 含弯引号时,把 new_string 的直引号转回弯引号,保持文件排版风格。
 * 启发式:行首或前是空白/开括号→左引号,前是字母→右引号(撇号,如 don't),否则右引号。
 */
function preserveQuoteStyle(actualOld: string, newString: string): string {
  if (!/[‘’“”]/.test(actualOld)) return newString; // 文件用直引号,无需转
  let result = '';
  for (let i = 0; i < newString.length; i++) {
    const ch = newString[i]!;
    const prev = i > 0 ? newString[i - 1]! : '';
    if (ch === "'") {
      result += prev === '' || /[\s([{\[]/.test(prev) ? '‘' : '’';
    } else if (ch === '"') {
      result += prev === '' || /[\s([{\[]/.test(prev) ? '“' : '”';
    } else {
      result += ch;
    }
  }
  return result;
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const FileEditTool = buildTool<FileEditInput, FileEditResult, BuiltinToolContext, FileEditToolContext>({
  id: BuiltinTools.FileEdit.id,
  name: BuiltinTools.FileEdit.name,
  description: `Replace an exact string in a file (str_replace semantics).

Rules:
- The file MUST have been read with \`Read\` in the current turn before editing.
- \`old_string\` must be unique in the file unless \`replace_all\` is true.
- Typographic/curly quotes in \`old_string\` are normalized automatically, so literal quotes from AI output match curly-quote source files.
- The file must not have been modified externally since it was read (mtime guard).`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  requires: ['workspaceRoot', 'readFileState'],

  validateContext(ctx) {
    if (!ctx.workspaceRoot || !ctx.readFileState || !ctx.toolCallId) {
      return contextFail('File 编辑工具未装配完整的工作区、读取状态或调用身份。');
    }
    return contextOk({
      readFileState: ctx.readFileState,
      signal: ctx.signal,
      toolCallId: ctx.toolCallId,
    });
  },

  validateInput(input) {
    // 空操作 edit 在准备阶段直接拒绝,避免产生假 FileChangePresentation。
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

  permissionMeta: {
    riskLevel: 'medium',
    accessType: 'write',
    extractPath: (input: unknown) => {
      const parsed = inputSchema.safeParse(input);
      return parsed.success ? parsed.data.file_path : undefined;
    },
  },

  async execute(
    input: FileEditInput,
    context: FileEditToolContext,
  ): Promise<FileEditResult> {
    const { file_path, old_string, replace_all } = input;
    const fullPath = path.resolve(file_path);

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

    let replacements = 0;
    const operationId = context.toolCallId;
    const written = await atomicTransformUtf8(
      file_path,
      operationId,
      context.signal,
      current => {
        if (!current.existed || current.content === null || current.mtimeMs === null) {
          throw new Error(`File no longer exists: ${file_path}`);
        }

        // Windows 上云同步或杀毒软件可能只改变 mtime；内容一致时仍可安全继续。
        if (current.mtimeMs !== cached.timestamp && current.content !== cached.content) {
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
        // 文件用弯引号时把 newString 直引号转回弯引号,保持排版风格
        const styledNew = preserveQuoteStyle(actual, newString);
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

    // 用编辑后内容更新缓存
    context.readFileState.set(fullPath, {
      content: written.content,
      timestamp: written.mtimeMs,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
      truncated: false,
    });
    return presentToolResult({
      filePath: file_path,
      replacements,
    }, createFileChangePresentation(file_path, written.previousContent, written.content));
  },
});
