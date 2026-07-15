import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  file_path: z
    .string()
    .min(1)
    .describe('Absolute path to the file to edit. Must have been read with fs_read first.'),
  old_string: z.string().describe('Exact string to find and replace. Must be unique in the file.'),
  new_string: z.string().describe('Replacement string.'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace every occurrence instead of requiring uniqueness.'),
});

type FsEditInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface FsEditResult {
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

  const normalizedSearch = normalizeQuotes(search);
  const normalizedFile = normalizeQuotes(fileContent);

  let idx = 0;
  while (idx < normalizedFile.length) {
    const found = normalizedFile.indexOf(normalizedSearch, idx);
    if (found === -1) return null;
    return fileContent.substring(found, found + search.length);
  }
  return null;
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

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const fsEditTool = buildTool<FsEditInput, FsEditResult>({
  name: 'fs_edit',
  description: `Replace an exact string in a file (str_replace semantics).

Rules:
- The file MUST have been read with \`fs_read\` in the current turn before editing.
- \`old_string\` must be unique in the file unless \`replace_all\` is true.
- Typographic/curly quotes in \`old_string\` are normalized automatically, so literal quotes from AI output match curly-quote source files.
- The file must not have been modified externally since it was read (mtime guard).`,

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

  async execute(input: FsEditInput, ctx: ToolExecutionContext): Promise<FsEditResult> {
    const { file_path, old_string, new_string, replace_all } = input;
    const fullPath = path.resolve(file_path);

    // ── 必须先读守卫 ─────────────────────────────────────────────────────────
    const cached = ctx.readFileState.get(fullPath);
    if (!cached) {
      throw new Error(
        `fs_edit requires the file to be read first. Call fs_read("${file_path}") before editing.`,
      );
    }
    if (cached.isPartialView) {
      throw new Error(
        `fs_edit requires a full read of the file. The cached view of "${file_path}" is partial ` +
          `(offset/limit was used). Call fs_read("${file_path}") without offset/limit first.`,
      );
    }

    // ── mtime 防覆盖 ──────────────────────────────────────────────────────────
    // 写前立即同步读当前文件(原子段)。
    let currentContent: string;
    let currentMtime: number;
    try {
      const stat = fs.statSync(fullPath);
      currentMtime = stat.mtimeMs;
      currentContent = fs.readFileSync(fullPath, 'utf8');
    } catch {
      throw new Error(`File no longer exists: ${file_path}`);
    }

    // Windows 上云同步/杀软可能不改内容却 bump mtime。
    // mtime 变了但内容和缓存一致时接受。
    if (currentMtime !== cached.timestamp && currentContent !== cached.content) {
      throw new Error(
        `File "${file_path}" was modified externally since it was read. ` +
          `Re-read it with fs_read before editing.`,
      );
    }

    // ── 查找目标字符串 ────────────────────────────────────────────────────────
    const actual = findActualString(currentContent, old_string);
    if (actual === null) {
      throw new Error(
        `The string to replace was not found in "${file_path}".\n\n` +
          `old_string:\n${old_string}\n\n` +
          `Verify the exact text by re-reading the file.`,
      );
    }

    const occurrences = countOccurrences(currentContent, actual);
    if (!replace_all && occurrences > 1) {
      throw new Error(
        `The string to replace appears ${occurrences} times in "${file_path}". ` +
          `Provide more context to make it unique, or set replace_all: true.`,
      );
    }

    // ── 应用替换(临界段 - 无 await)───────────────────────────────────────
    const newContent = replace_all
      ? currentContent.split(actual).join(new_string)
      : currentContent.replace(actual, new_string);

    fs.writeFileSync(fullPath, newContent, { encoding: 'utf8' });

    const newMtime = fs.statSync(fullPath).mtimeMs;

    // 用编辑后内容更新缓存
    ctx.readFileState.set(fullPath, {
      content: newContent,
      timestamp: newMtime,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });
    ctx.fileStateStore?.record(fullPath, { content: newContent, mtimeMs: newMtime, offset: undefined, limit: undefined, isPartialView: false });

    return {
      filePath: file_path,
      replacements: replace_all ? occurrences : 1,
    };
  },
});
