import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

// ── Input schema ──────────────────────────────────────────────────────────────

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

// ── Output type ───────────────────────────────────────────────────────────────

export interface FsEditResult {
  filePath: string;
  replacements: number;
}

// ── Quote normalization ───────────────────────────────────────────────────────

/** Normalize typographic quotes to straight ASCII equivalents for matching. */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛′‵]/g, "'") // single curly → '
    .replace(/[“”„‟″‶]/g, '"'); // double curly → "
}

/**
 * Locate `search` in `fileContent`, trying exact match first then
 * quote-normalized fallback. Returns the actual substring from the file
 * so the replacement can use the file's own quote style.
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

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ── Tool definition ───────────────────────────────────────────────────────────

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

    // ── Must-read-first guard ─────────────────────────────────────────────────
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

    // ── mtime anti-overwrite ──────────────────────────────────────────────────
    // Read the current file synchronously immediately before writing (atomic section).
    let currentContent: string;
    let currentMtime: number;
    try {
      const stat = fs.statSync(fullPath);
      currentMtime = stat.mtimeMs;
      currentContent = fs.readFileSync(fullPath, 'utf8');
    } catch {
      throw new Error(`File no longer exists: ${file_path}`);
    }

    // On Windows, cloud sync / AV may bump mtime without changing content.
    // Accept if mtime changed but content is identical to what was cached.
    if (currentMtime !== cached.timestamp && currentContent !== cached.content) {
      throw new Error(
        `File "${file_path}" was modified externally since it was read. ` +
          `Re-read it with fs_read before editing.`,
      );
    }

    // ── Find the target string ────────────────────────────────────────────────
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

    // ── Apply replacement (critical section — no await) ───────────────────────
    const newContent = replace_all
      ? currentContent.split(actual).join(new_string)
      : currentContent.replace(actual, new_string);

    fs.writeFileSync(fullPath, newContent, { encoding: 'utf8' });

    const newMtime = fs.statSync(fullPath).mtimeMs;

    // Update cache with post-edit content
    ctx.readFileState.set(fullPath, {
      content: newContent,
      timestamp: newMtime,
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    });

    return {
      filePath: file_path,
      replacements: replace_all ? occurrences : 1,
    };
  },
});
