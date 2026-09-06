import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CompleteMemoryLlm } from '../common/extraction.js';
import { MemoryConsolidationError } from '../errors.js';

export const CONSOLIDATION_INPUT_INSTRUCTION =
  '以下是本批未整合提取结果、盘上差异和正式记忆。按 system 指令只输出 JSON 数组；没有文件改动时输出 []。';

export type ConsolidationEdit =
  | { readonly path: string; readonly operation: 'write'; readonly content: string }
  | { readonly path: string; readonly operation: 'delete' };

export interface ConsolidationSource {
  readonly turnId: string;
  readonly content: string;
  readonly characterName?: string;
}

export interface RunConsolidationLlmInput {
  readonly memoryDirectory: string;
  readonly currentPaths: readonly string[];
  readonly isAllowedTargetPath: (relativePath: string) => boolean;
  readonly diffFile: string;
  readonly unintegrated: readonly ConsolidationSource[];
  readonly maxInputBytes: number;
  readonly systemTemplate: string;
  readonly inputTemplate: string;
  readonly complete: CompleteMemoryLlm;
  readonly signal?: AbortSignal;
}

export interface MemoryConsolidationResult {
  readonly edits: readonly ConsolidationEdit[];
  /** 程序实际装入本次 LLM 输入的结果；只有这些 Turn 才能在 SQL 标记为已整合。 */
  readonly consumedTurnIds: readonly string[];
}

export async function runConsolidationLlm(
  input: RunConsolidationLlmInput,
): Promise<MemoryConsolidationResult> {
  const rendered = await buildConsolidationInput(input);
  const raw = await input.complete([
    { role: 'system', content: input.systemTemplate.trim() },
    { role: 'user', content: `${input.inputTemplate.trim()}\n\n${rendered.text}` },
  ], input.signal);
  return {
    edits: parseConsolidationEdits(raw, input.isAllowedTargetPath),
    consumedTurnIds: rendered.consumedTurnIds,
  };
}

export function parseConsolidationEdits(
  raw: string,
  isAllowedTargetPath: (relativePath: string) => boolean,
): ConsolidationEdit[] {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new MemoryConsolidationError('整合输出不是合法 JSON 数组');
  }
  if (!Array.isArray(value)) {
    throw new MemoryConsolidationError('整合输出必须是 JSON 数组');
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项不是对象`);
    }
    if (item.operation !== 'write' && item.operation !== 'delete') {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项 operation 非法`);
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项缺少 path`);
    }
    const normalized = normalizeRelativePath(item.path);
    if (!isAllowedTargetPath(normalized)) {
      throw new MemoryConsolidationError(`整合输出路径不在白名单: ${item.path}`);
    }
    if (item.operation === 'write') {
      if (typeof item.content !== 'string') {
        throw new MemoryConsolidationError(`整合输出第 ${index} 项 write 缺少 content`);
      }
      if (!hasOnlyKeys(item, ['path', 'operation', 'content'])) {
        throw new MemoryConsolidationError(`整合输出第 ${index} 项包含多余字段`);
      }
      return { path: normalized, operation: 'write', content: item.content };
    }
    if (!hasOnlyKeys(item, ['path', 'operation'])) {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项包含多余字段`);
    }
    return { path: normalized, operation: 'delete' };
  });
}

export async function applyConsolidationEdits(
  memoryDirectory: string,
  edits: readonly ConsolidationEdit[],
  signal: AbortSignal,
): Promise<void> {
  const root = path.resolve(memoryDirectory);
  for (const edit of edits) {
    if (signal.aborted) throw signal.reason;
    const full = path.resolve(root, edit.path);
    if (!isInside(root, full)) {
      throw new MemoryConsolidationError(`整合输出路径越界: ${edit.path}`);
    }
    if (edit.operation === 'delete') {
      await fs.rm(full, { force: true });
    } else {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, edit.content, 'utf8');
    }
  }
}

interface RenderedFile {
  readonly path: string;
  readonly content: string;
}

interface RenderedConsolidationInput {
  readonly text: string;
  readonly consumedTurnIds: readonly string[];
}

async function buildConsolidationInput(
  input: RunConsolidationLlmInput,
): Promise<RenderedConsolidationInput> {
  const files: RenderedFile[] = [];
  for (const relativePath of input.currentPaths) {
    try {
      files.push({
        path: relativePath,
        content: await fs.readFile(path.join(input.memoryDirectory, relativePath), 'utf8'),
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  let diff = '(无差异)';
  try {
    diff = await fs.readFile(input.diffFile, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let text = '';
  const consumedTurnIds: string[] = [];
  for (const result of input.unintegrated) {
    const body = result.characterName
      ? `# ${result.characterName}\n\n${result.content}`
      : result.content;
    const heading = consumedTurnIds.length === 0
      ? '## 未整合提取结果\n\n'
      : '\n\n';
    const candidate = `${text}${heading}${body}`;
    if (byteLength(candidate) > input.maxInputBytes) {
      if (consumedTurnIds.length === 0) {
        throw new MemoryConsolidationError('单条提取结果超过整合输入预算');
      }
      break;
    }
    text = candidate;
    consumedTurnIds.push(result.turnId);
  }

  text = appendTruncatedSection(text, `## 盘上差异\n\n${diff}`, input.maxInputBytes);
  if (files.length > 0) {
    text = appendTruncatedSection(
      text,
      '## 现有正式记忆文件\n\n'
        + files.map(file => `### ${file.path}\n\n${file.content}`).join('\n\n'),
      input.maxInputBytes,
    );
  }
  return { text, consumedTurnIds };
}

function appendTruncatedSection(current: string, section: string, maxBytes: number): string {
  const separator = current.length === 0 ? '' : '\n\n';
  const remaining = maxBytes - byteLength(current) - byteLength(separator);
  if (remaining <= 0) return current;
  if (byteLength(section) <= remaining) return `${current}${separator}${section}`;
  const marker = '\n\n[本节因输入预算而截断]';
  const contentBytes = remaining - byteLength(marker);
  return contentBytes > 0
    ? `${current}${separator}${truncateUtf8(section, contentBytes)}${marker}`
    : current;
}

export async function listMarkdownFiles(root: string, subdir: string): Promise<string[]> {
  const directory = path.join(root, subdir);
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => toPosixPath(path.relative(root, path.join(directory, entry.name))));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
}

function normalizeRelativePath(value: string): string {
  return value.trim().replace(/^\.\/+/, '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
    && Object.keys(value).length === allowed.length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let result = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (result.endsWith('\uFFFD')) result = result.slice(0, -1);
  return result;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
