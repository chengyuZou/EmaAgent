// 把一批提取结果、用户编辑和正式记忆交给 LLM，产出可执行的文件改动。

import { existsSync, readdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryExtractionResult } from '@ema-agent/storage';
import {
  runTurnExtraction,
  type CompleteExtraction,
} from '../common/extraction.js';
import { MemoryConsolidationError } from '../errors.js';

/** 整合输入前的固定指令（system 模板自包含输出协议，这里只引导拼接）。 */
export const CONSOLIDATION_INPUT_INSTRUCTION =
  '以下是本次整合输入（未整合结果 / 工作区差异 / 现有正式记忆文件）。'
  + '按 system 指令处理，只输出 JSON 数组；没有需要改动的文件时输出 []。';

/** LLM 返回的单个文件改动（path 相对记忆根，posix 风格）。 */
export interface ConsolidationEdit {
  readonly path: string;
  readonly operation: 'write' | 'delete';
  readonly content?: string;
}

export interface RunConsolidationLlmInput {
  readonly memoryDirectory: string;
  /** 当前存在的正式记忆和便签，用于构造整合输入。 */
  readonly currentPaths: readonly string[];
  /** 该轨允许写入或删除的路径规则；正式结构可新建，便签只能处理已有文件。 */
  readonly isAllowedTargetPath: (relativePath: string) => boolean;
  /** 工作区差异文件（notes/用户编辑），由 runConsolidationJobs 生成。 */
  readonly diffFile: string;
  /** 未整合提取结果（按 created_at 稳定排序）。 */
  readonly unintegrated: readonly MemoryExtractionResult[];
  /** 输入预算上限（consolidationInputBytes）。 */
  readonly maxInputBytes: number;
  readonly systemTemplate: string;
  readonly inputTemplate: string;
  readonly complete: CompleteExtraction;
  readonly signal?: AbortSignal;
}

export interface ConsolidationPlan {
  readonly edits: readonly ConsolidationEdit[];
  /** 真正完整进入本轮 LLM 输入的提取结果；只有这些结果可以标记为已整合。 */
  readonly extractionJobIds: readonly string[];
}

/** 一次整合 LLM 调用，返回文件改动和本轮实际消费的提取结果。 */
export async function runConsolidationLlm(
  input: RunConsolidationLlmInput,
): Promise<ConsolidationPlan> {
  const rendered = await buildConsolidationInput(input);
  const raw = await runTurnExtraction(
    input.systemTemplate,
    input.inputTemplate,
    rendered.text,
    input.complete,
    input.signal,
  );
  return {
    edits: raw === undefined
      ? []
      : parseConsolidationEdits(raw, input.isAllowedTargetPath),
    extractionJobIds: rendered.extractionJobIds,
  };
}

/** 把 LLM 输出解析为校验后的改动列表（含 path 白名单 / operation 校验）。 */
export function parseConsolidationEdits(
  raw: string,
  isAllowedTargetPath: (relativePath: string) => boolean,
): ConsolidationEdit[] {
  const jsonText = extractJsonArrayText(raw);
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
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
    const operation = item.operation;
    if (operation !== 'write' && operation !== 'delete') {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项 operation 非法`);
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new MemoryConsolidationError(`整合输出第 ${index} 项缺少 path`);
    }
    const normalized = normalizeRelativePath(item.path);
    if (!isAllowedTargetPath(normalized)) {
      throw new MemoryConsolidationError(`整合输出路径不在白名单: ${item.path}`);
    }
    if (operation === 'write') {
      if (typeof item.content !== 'string') {
        throw new MemoryConsolidationError(`整合输出第 ${index} 项 write 缺少 content`);
      }
      return { path: normalized, operation, content: item.content };
    }
    return { path: normalized, operation };
  });
}

/** 应用校验后的改动（utf8 写/删，锁在 memoryDirectory 内）。 */
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
      await fs.writeFile(full, edit.content ?? '', 'utf8');
    }
  }
}

// ── 输入打包 ──────────────────────────────────────────────────────────────────

interface RenderedFile {
  readonly rel: string;
  readonly content: string;
}

interface ConsolidationInput {
  readonly files: readonly RenderedFile[];
  readonly diff: string;
  readonly results: readonly {
    readonly jobId: string;
    readonly content: string;
  }[];
}

interface RenderedConsolidationInput {
  readonly text: string;
  readonly extractionJobIds: readonly string[];
}

async function buildConsolidationInput(
  input: RunConsolidationLlmInput,
): Promise<RenderedConsolidationInput> {
  const files: RenderedFile[] = [];
  for (const rel of input.currentPaths) {
    const full = path.join(input.memoryDirectory, rel);
    try {
      const content = await fs.readFile(full, 'utf8');
      files.push({ rel, content });
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }
  let diff: string;
  try {
    diff = await fs.readFile(input.diffFile, 'utf8');
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    diff = '(无差异)';
  }
  const results = input.unintegrated.map((result) => ({
    jobId: result.jobId,
    content: `### Job ${result.jobId} · turn ${result.turnId}\n\n${result.content}`,
  }));
  return renderConsolidationInput({ files, diff, results }, input.maxInputBytes);
}

function renderConsolidationInput(
  input: ConsolidationInput,
  maxBytes: number,
): RenderedConsolidationInput {
  let text = '';
  const extractionJobIds: string[] = [];

  for (let index = 0; index < input.results.length; index += 1) {
    const result = input.results[index]!;
    const heading = extractionJobIds.length === 0
      ? '## 未整合提取结果（按时间序，待合入正式记忆）\n\n'
      : '\n\n';
    const candidate = `${text}${heading}${result.content}`;
    if (byteLength(candidate) > maxBytes) {
      if (extractionJobIds.length === 0) {
        throw new MemoryConsolidationError('单条提取结果超过整合输入预算');
      }
      break;
    }
    text = candidate;
    extractionJobIds.push(result.jobId);
  }

  text = appendTruncatedSection(
    text,
    `## 工作区差异（notes / 用户编辑；只读，不要照抄）\n\n${input.diff}`,
    maxBytes,
  );
  if (input.files.length > 0) {
    text = appendTruncatedSection(
      text,
      '## 现有正式记忆文件（路径相对记忆根）\n\n'
        + input.files
          .map((file) => `### ${file.rel}\n\n${file.content}`)
          .join('\n\n'),
      maxBytes,
    );
  }
  return { text, extractionJobIds };
}

function appendTruncatedSection(
  current: string,
  section: string,
  maxBytes: number,
): string {
  const separator = current.length === 0 ? '' : '\n\n';
  const remaining = maxBytes - byteLength(current) - byteLength(separator);
  if (remaining <= 0) return current;
  if (byteLength(section) <= remaining) return `${current}${separator}${section}`;

  const marker = '\n\n[本节因整合输入预算而截断]';
  const contentBytes = remaining - byteLength(marker);
  if (contentBytes <= 0) return current;
  return `${current}${separator}${truncateUtf8(section, contentBytes)}${marker}`;
}

// ── 白名单枚举工具（work/relationship 轨共用） ───────────────────────────────

/** 列出 subdir 下所有 .md 的相对路径（posix；不存在返回空数组）。 */
export function listMarkdownFiles(root: string, subdir: string): string[] {
  const dir = path.join(root, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => toPosixPath(path.relative(root, path.join(dir, entry))));
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function extractJsonArrayText(raw: string): string {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new MemoryConsolidationError('整合输出中找不到 JSON 数组');
  }
  return raw.slice(start, end + 1);
}

/** 白名单比对用：./ 前缀去掉、反斜杠归一为 /、去尾部斜杠与空白。 */
function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let result = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
  while (result.endsWith('\uFFFD')) {
    result = result.slice(0, -1);
  }
  return result;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
