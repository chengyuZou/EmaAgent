import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { estimateTextTokens } from '@ema-agent/token';

export const DEFAULT_SEARCH_MAX_RESULTS = 200;
export const MAX_SEARCH_RESULTS = 200;
export const DEFAULT_LIST_MAX_RESULTS = 2_000;
export const MAX_LIST_RESULTS = 2_000;
export const DEFAULT_READ_MAX_TOKENS = 20_000;
export const MEMORY_PREVIEW_FILES = 5;
export const MEMORY_PREVIEW_BYTES = 2 * 1024;

export interface MemoryPreview {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * any 接受任一关键词, all_on_same_line 要求同一行含全部关键词.
 * all_within_lines 检查从当前行开始的连续 5 行, 不是前后各 5 行.
 */
export type MemorySearchMatchMode =
  | 'any'
  | 'all_on_same_line'
  | 'all_within_lines';

export interface MemorySearchMatch {
  /** 相对记忆根的路径, 使用 '/'. */
  readonly path: string;
  /** 从 1 开始的命中行号. */
  readonly matchLineNumber: number;
  /** 片段首行号, 包含前文时可能早于命中行. */
  readonly contentStartLineNumber: number;
  readonly content: string;
  /** 实际命中的关键词, 保留原大小写. */
  readonly matchedQueries: readonly string[];
}

export interface MemorySearchRequest {
  /** 子串关键词, 去掉首尾空白后为空的项被忽略. */
  readonly queries: readonly string[];
  /** 缺省 any. */
  readonly matchMode?: MemorySearchMatchMode;
  /** 相对记忆根的搜索目录, 例如 work 或 relationship/characters/ema. */
  readonly path?: string;
  /** 上次结果的 nextCursor, 表示跳过多少条命中. */
  readonly cursor?: string;
  /** 前后各保留的上下文行数, 默认 0. */
  readonly contextLines?: number;
  /** 默认 true. */
  readonly caseSensitive?: boolean;
  /** 默认 false; 开启后将反斜杠和连续斜杠统一成 '/'. */
  readonly normalized?: boolean;
  /** 默认 200, 最多 200. */
  readonly maxResults?: number;
  /** 取消时抛出 signal.reason. */
  readonly signal?: AbortSignal;
}

export interface MemorySearchResponse {
  readonly queries: readonly string[];
  readonly matchMode: MemorySearchMatchMode;
  readonly path?: string;
  readonly matches: readonly MemorySearchMatch[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface MemoryListEntry {
  readonly path: string;
  readonly entryType: 'file' | 'directory';
}

export interface MemoryListRequest {
  readonly path?: string;
  readonly cursor?: string;
  readonly maxResults?: number;
  /** 取消时抛出 signal.reason. */
  readonly signal?: AbortSignal;
}

export interface MemoryListResponse {
  readonly path?: string;
  readonly entries: readonly MemoryListEntry[];
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

export interface MemoryReadRequest {
  readonly path: string;
  readonly lineOffset?: number;
  readonly maxLines?: number;
  /** 取消会中止文件读取并抛出, 由工具执行器处理. */
  readonly signal?: AbortSignal;
}

export interface MemoryReadResponse {
  readonly path: string;
  readonly startLineNumber: number;
  readonly content: string;
  readonly truncated: boolean;
}

export type SearchMemory = (request: MemorySearchRequest) => Promise<MemorySearchResponse>;

export type ReadMemory = (request: MemoryReadRequest) => Promise<MemoryReadResponse | undefined>;

export type ListMemory = (request: MemoryListRequest) => Promise<MemoryListResponse>;

export async function searchMemoryFiles(
  memoryRoot: string,
  request: MemorySearchRequest,
): Promise<MemorySearchResponse> {
  throwIfAborted(request.signal);
  const queries = request.queries
    .map((query) => query.trim())
    .filter((query) => query.length > 0);
  const matchMode = request.matchMode ?? 'any';
  const caseSensitive = request.caseSensitive ?? true;
  const normalized = request.normalized ?? false;
  const contextLines = request.contextLines ?? 0;
  const maxResults = clamp(
    request.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
    1,
    MAX_SEARCH_RESULTS,
  );
  const startIndex = parseCursor(request.cursor);

  if (queries.length === 0) {
    return { queries, matchMode, path: request.path, matches: [], truncated: false };
  }
  const normalizedQueries = queries.map((query) =>
    normalizeText(query, caseSensitive, normalized),
  );
  const matches: MemorySearchMatch[] = [];
  let skipped = 0;
  let hasMore = false;

  for (const rel of await listReadableFiles(memoryRoot, request.path)) {
    throwIfAborted(request.signal);
    const content = await readFileSafe(path.join(memoryRoot, rel), request.signal);
    if (content === undefined) continue;
    const shouldContinue = visitFileMatches(rel, content, {
      originalQueries: queries,
      normalizedQueries,
      matchMode,
      caseSensitive,
      normalized,
      contextLines,
      visit(match) {
        if (skipped < startIndex) {
          skipped += 1;
          return true;
        }
        if (matches.length < maxResults) {
          matches.push(match);
          return true;
        }
        hasMore = true;
        return false;
      },
    });
    if (!shouldContinue) break;
  }
  return {
    queries,
    matchMode,
    path: request.path,
    matches,
    nextCursor: hasMore ? String(startIndex + matches.length) : undefined,
    truncated: hasMore,
  };
}

interface AppendMatchesOptions {
  readonly originalQueries: readonly string[];
  readonly normalizedQueries: readonly string[];
  readonly matchMode: MemorySearchMatchMode;
  readonly caseSensitive: boolean;
  readonly normalized: boolean;
  readonly contextLines: number;
  readonly visit: (match: MemorySearchMatch) => boolean;
}

function visitFileMatches(
  rel: string,
  content: string,
  options: AppendMatchesOptions,
): boolean {
  const {
    originalQueries,
    normalizedQueries,
    matchMode,
    caseSensitive,
    normalized,
    contextLines,
  } = options;
  const lines = content.split('\n');
  const window = matchMode === 'all_within_lines' ? readWindow() : 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeText(lines[index] ?? '', caseSensitive, normalized);
    const matchedIndexes = matchQueriesOnLine(
      line,
      normalizedQueries,
      matchMode,
      lines,
      index,
      caseSensitive,
      normalized,
      window,
    );
    if (matchedIndexes.length === 0) continue;

    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length, index + contextLines + 1);
    if (!options.visit({
      path: rel,
      matchLineNumber: index + 1,
      contentStartLineNumber: start + 1,
      content: lines.slice(start, end).join('\n'),
      matchedQueries: matchedIndexes.map((matchedIndex) => originalQueries[matchedIndex]!),
    })) return false;
  }
  return true;
}

function matchQueriesOnLine(
  line: string,
  queries: readonly string[],
  matchMode: MemorySearchMatchMode,
  lines: readonly string[],
  index: number,
  caseSensitive: boolean,
  normalized: boolean,
  window: number,
): number[] {
  const contains = (query: string, text: string): boolean => text.includes(query);
  switch (matchMode) {
    case 'any':
      return queries.flatMap((query, queryIndex) =>
        contains(query, line) ? [queryIndex] : [],
      );
    case 'all_on_same_line':
      return queries.every((query) => contains(query, line))
        ? queries.map((_, queryIndex) => queryIndex)
        : [];
    case 'all_within_lines': {
      const end = Math.min(lines.length, index + window);
      const text = lines
        .slice(index, end)
        .map((l) => normalizeText(l, caseSensitive, normalized))
        .join('\n');
      return queries.every((query) => contains(query, text))
        ? queries.map((_, queryIndex) => queryIndex)
        : [];
    }
  }
}
function readWindow(): number {
  return 5;
}

function normalizeText(value: string, caseSensitive: boolean, normalized: boolean): string {
  let result = value;
  if (!caseSensitive) result = result.toLowerCase();
  if (normalized) result = result.replace(/[\\/]+/g, '/');
  return result;
}

export async function readMemoryFile(
  memoryRoot: string,
  request: MemoryReadRequest,
): Promise<MemoryReadResponse | undefined> {
  if (!await isReadableFile(memoryRoot, request.path)) return undefined;
  const full = path.join(memoryRoot, request.path);
  const content = await readFileSafe(full, request.signal);
  if (content === undefined) return undefined;
  const lines = content.split('\n');
  const lineOffset = Math.max(1, request.lineOffset ?? 1);
  const startIndex = Math.min(lineOffset - 1, lines.length);
  const available = lines.slice(startIndex);
  const lineLimit = request.maxLines === undefined
    ? available.length
    : Math.max(0, Math.trunc(request.maxLines));
  const requested = available.slice(0, lineLimit);
  const includedLines = largestReadablePrefix(requested);
  const text = requested.slice(0, includedLines).join('\n');

  return {
    path: request.path,
    startLineNumber: startIndex + 1,
    content: text,
    truncated: includedLines < available.length,
  };
}

export async function readMemoryPreviews(
  memoryRoot: string,
  signal?: AbortSignal,
): Promise<readonly MemoryPreview[]> {
  throwIfAborted(signal);
  const candidates: { path: string; modifiedAt: number }[] = [];
  for (const relativePath of await listReadableFiles(memoryRoot)) {
    throwIfAborted(signal);
    try {
      const stat = await fs.stat(path.join(memoryRoot, relativePath));
      if (stat.isFile() && stat.size > 0) {
        candidates.push({ path: relativePath, modifiedAt: stat.mtimeMs });
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  candidates.sort((left, right) => {
    const timeOrder = right.modifiedAt - left.modifiedAt;
    return timeOrder || left.path.localeCompare(right.path);
  });
  const previews = await Promise.all(
    candidates.slice(0, MEMORY_PREVIEW_FILES).map(candidate => (
      readPreviewPrefix(memoryRoot, candidate.path, signal)
    )),
  );
  return previews.filter((preview): preview is MemoryPreview => preview !== undefined);
}

async function readPreviewPrefix(
  memoryRoot: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<MemoryPreview | undefined> {
  throwIfAborted(signal);
  let file;
  try {
    file = await fs.open(path.join(memoryRoot, relativePath), 'r');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, MEMORY_PREVIEW_BYTES));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      throwIfAborted(signal);
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    throwIfAborted(signal);
    const truncated = size > bytesRead;
    // 只分配和读取预览上限内的字节. 截断时不输出末尾尚未读全的 UTF-8 字符.
    const decoder = new StringDecoder('utf8');
    let content = decoder.write(buffer.subarray(0, bytesRead));
    if (!truncated) content += decoder.end();
    return { path: relativePath, content, truncated };
  } finally {
    await file.close();
  }
}

export async function listMemoryFiles(
  memoryRoot: string,
  request: MemoryListRequest = {},
): Promise<MemoryListResponse> {
  const base = request.path ? path.join(memoryRoot, request.path) : memoryRoot;
  const maxResults = clamp(
    request.maxResults ?? DEFAULT_LIST_MAX_RESULTS,
    1,
    MAX_LIST_RESULTS,
  );
  const startIndex = parseCursor(request.cursor);

  throwIfAborted(request.signal);
  const all: MemoryListEntry[] = [];
  const fullBase = path.resolve(memoryRoot, base);
  if (isInsideOrEqual(memoryRoot, fullBase) && !isHiddenRelative(path.relative(memoryRoot, fullBase))) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(fullBase, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) entries = [];
      else throw error;
    }
    for (const entry of entries) {
      throwIfAborted(request.signal);
      const rel = toPosix(path.relative(memoryRoot, path.join(fullBase, entry.name)));
      if (isHiddenRelative(rel) || isExcludedRelative(rel)) continue;
      const full = path.join(fullBase, entry.name);
      if (entry.isDirectory()) all.push({ path: rel, entryType: 'directory' });
      else if (entry.isFile()) all.push({ path: rel, entryType: 'file' });
    }
  }
  all.sort((left, right) => left.path.localeCompare(right.path));

  const endIndex = Math.min(startIndex + maxResults, all.length);
  const hasMore = endIndex < all.length;
  return {
    path: request.path,
    entries: all.slice(startIndex, endIndex),
    nextCursor: hasMore ? String(endIndex) : undefined,
    truncated: hasMore,
  };
}

/**
 * 搜索与预览只枚举非隐藏 Markdown, 排除 Git 工作文件和注入用摘要.
 */
async function listReadableFiles(memoryRoot: string, scopePath?: string): Promise<string[]> {
  const start = scopePath ? path.join(memoryRoot, scopePath) : memoryRoot;
  const result: string[] = [];
  const fullStart = path.resolve(memoryRoot, start);
  if (!isInsideOrEqual(memoryRoot, fullStart)) return result;
  await walkReadable(fullStart, result, memoryRoot);
  return result.sort((left, right) => left.localeCompare(right));
}

async function walkReadable(directory: string, out: string[], memoryRoot: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const rel = toPosix(path.relative(memoryRoot, full));
    if (isHiddenRelative(rel)) continue;
    if (isExcludedRelative(rel)) continue;
    if (entry.isDirectory()) {
      await walkReadable(full, out, memoryRoot);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
}

async function isReadableFile(memoryRoot: string, relativePath: string): Promise<boolean> {
  const rel = toPosix(relativePath.replace(/^\.\/+/, ''));
  if (isHiddenRelative(rel) || isExcludedRelative(rel)) return false;
  const full = path.resolve(memoryRoot, rel);
  if (!isInside(memoryRoot, full)) return false;
  try {
    return (await fs.stat(full)).isFile();
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isHiddenRelative(rel: string): boolean {
  return rel.split('/').some((segment) => segment.startsWith('.'));
}

function isExcludedRelative(rel: string): boolean {
  if (
    rel === 'memory_summary.md'
    || rel.endsWith('/memory_summary.md')
    || rel === 'memory_workspace_diff.md'
    || rel.endsWith('/memory_workspace_diff.md')
  ) return true;
  return false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function readFileSafe(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, { encoding: 'utf8', signal });
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function largestReadablePrefix(lines: readonly string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(lines.slice(0, middle).join('\n')) <= DEFAULT_READ_MAX_TOKENS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  return path.resolve(root) === path.resolve(candidate) || isInside(root, candidate);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Memory 文件操作已取消');
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}
