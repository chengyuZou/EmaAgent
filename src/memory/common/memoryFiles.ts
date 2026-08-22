// 搜索、读取和列举用户可见的正式 Memory 文件。

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { estimateTextTokens } from '@ema-agent/token';

export const DEFAULT_SEARCH_MAX_RESULTS = 200;
export const MAX_SEARCH_RESULTS = 200;
export const DEFAULT_LIST_MAX_RESULTS = 2_000;
export const MAX_LIST_RESULTS = 2_000;
export const DEFAULT_READ_MAX_TOKENS = 20_000;

// ── 公开请求与响应 ────────────────────────────────────────

/**
 * 关键词匹配
 * - any：任一关键词命中即算；
 * - all_on_same_line：全部关键词必须落在同一行；
 * - all_within_lines：全部关键词必须落在同一邻近行窗口（readWindow 行数）内。
 */
export type MemorySearchMatchMode =
  | 'any'
  | 'all_on_same_line'
  | 'all_within_lines';

/** 一条命中：文件路径、命中行号、片段起始行号与片段正文。 */
export interface MemorySearchMatch {
  /** 相对记忆根的 posix 路径。 */
  readonly path: string;
  /** 命中行号（1-based）。 */
  readonly matchLineNumber: number;
  /** 返回片段的首行号（contextLines > 0 时早于命中行）。 */
  readonly contentStartLineNumber: number;
  /** 命中片段正文（含上下文行）。 */
  readonly content: string;
  /** 本次实际命中的关键词（原始大小写）。 */
  readonly matchedQueries: readonly string[];
}

/** 搜索请求；queries 为子串关键词，其余字段全部可选。 */
export interface MemorySearchRequest {
  /** 要搜索的关键词（子串匹配；去空白后为空的全被忽略）。 */
  readonly queries: readonly string[];
  /** 匹配模式，缺省 any。 */
  readonly matchMode?: MemorySearchMatchMode;
  /** 限定搜索的相对子目录（如 work、relationship/characters/ema）。 */
  readonly path?: string;
  /** 分页游标（来自上次结果的 next_cursor）。 */
  readonly cursor?: string;
  /** 命中片段带多少上下文行（默认 0）。 */
  readonly contextLines?: number;
  /** 大小写敏感（默认 true）。 */
  readonly caseSensitive?: boolean;
  /** 分隔符归一后匹配（默认 false）。 */
  readonly normalized?: boolean;
  /** 结果上限（默认 200）。 */
  readonly maxResults?: number;
  /** 工具执行取消信号；中止时抛出 signal.reason。 */
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
  /** 工具执行取消信号；中止时抛出 signal.reason。 */
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
  /** 工具执行取消信号；中止时底层读抛出，由执行框架收口。 */
  readonly signal?: AbortSignal;
}

export interface MemoryReadResponse {
  readonly path: string;
  readonly startLineNumber: number;
  readonly content: string;
  readonly truncated: boolean;
}

// ── 窄能力类型（宿主注入已绑定 memoryRoot 后供 ToolUseContext 引用） ──────────

export type SearchMemory = (request: MemorySearchRequest) => Promise<MemorySearchResponse>;

export type ReadMemory = (request: MemoryReadRequest) => Promise<MemoryReadResponse | undefined>;

export type ListMemory = (request: MemoryListRequest) => Promise<MemoryListResponse>;

// ── search ─────────────────────────────────────────────────────────────────────

export async function searchMemoryFiles(
  memoryRoot: string,
  request: MemorySearchRequest,
): Promise<MemorySearchResponse> {
  // 已中止则立即返回，避免先枚举全部可读文件白做工；循环内另有逐文件检查。
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
/** all_within_lines 的邻近行窗口行数（固定 5，跨文件一致）。 */
function readWindow(): number {
  return 5;
}

function normalizeText(value: string, caseSensitive: boolean, normalized: boolean): string {
  let result = value;
  if (!caseSensitive) result = result.toLowerCase();
  if (normalized) result = result.replace(/[\\/]+/g, '/');
  return result;
}

// ── read ───────────────────────────────────────────────────────────────────────

export async function readMemoryFile(
  memoryRoot: string,
  request: MemoryReadRequest,
): Promise<MemoryReadResponse | undefined> {
  if (!await isReadableFile(memoryRoot, request.path)) return undefined;
  const content = await readFileSafe(path.join(memoryRoot, request.path), request.signal);
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

// ── list ───────────────────────────────────────────────────────────────────────

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

// ── 可读范围（正式记忆白名单） ─────────────────────────────────────────────────

/**
 * 枚举 memory 根下允许模型读取的文件（相对路径，posix）。
 * 排除：隐藏项、.git、turn_evidence、extensions/notes、memory_summary.md。
 * scopePath 可选：限定在某轨/某子目录下。
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

/** 隐藏项（.git / .xxx / 以 . 开头目录）。 */
function isHiddenRelative(rel: string): boolean {
  return rel.split('/').some((segment) => segment.startsWith('.'));
}

/** 派生/内部文件不进入模型可读范围。 */
function isExcludedRelative(rel: string): boolean {
  if (
    rel === 'memory_summary.md'
    || rel.endsWith('/memory_summary.md')
    || rel === 'memory_workspace_diff.md'
    || rel.endsWith('/memory_workspace_diff.md')
  ) return true;
  const segments = rel.split('/');
  return segments.includes('turn_evidence')
    || segments.includes('extensions');
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

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
