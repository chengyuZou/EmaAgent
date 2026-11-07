import { Buffer } from 'node:buffer';
import type { LogError, LogRow, LogValue } from '../types.js';

/** 单条日志编码后的硬上限(含末尾换行) */
export const MAX_LOG_BYTES = 8 * 1024;

/** normalize 阶段单个字符串原值的上限: 超过则整体省略, 避免留下凭据的半截前缀 */
const MAX_VALUE_BYTES = 16 * 1024;
/** 数组/对象成员数量上限 */
const MAX_MEMBERS = 32;
/** 单次 normalize 访问的节点总数上限 */
const MAX_NODES = 256;
/** 递归深度上限 */
const MAX_DEPTH = 6;
/** 属性名长度上限 */
const MAX_KEY_BYTES = 256;
/** encode 阶段字符串截断上限 */
const MAX_STRING_BYTES = 2048;

const TRUNCATED_SUFFIX = '...[truncated]';

function omittedValue(reason: string): string {
  return `[omitted: ${reason}]`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

interface NormalizeState {
  /** 当前递归栈上的对象, 用于检测循环引用(不是所有访问过的对象) */
  ancestors: WeakSet<object>;
  nodesVisited: number;
  truncated: boolean;
}

function omit(state: NormalizeState, reason: string): string {
  state.truncated = true;
  return omittedValue(reason);
}

export function normalizeLogText(text: string, state: TruncationState): string {
  if (byteLength(text) <= MAX_VALUE_BYTES) return text;
  state.truncated = true;
  return omittedValue('oversized log value');
}

export function normalizeLogBody(body: LogRow['body']): Pick<LogRow, 'body' | 'truncated'> {
  const state: NormalizeState = {
    ancestors: new WeakSet(),
    nodesVisited: 0,
    truncated: false,
  };

  const normalized = normalizeValue(body, 0, state);

  const isPlainObject =
    normalized !== null &&
    typeof normalized === 'object' &&
    !Array.isArray(normalized);

  return {
    body: isPlainObject
      ? (normalized as Record<string, LogValue>)
      : { error: omittedValue('unreadable log body') },
    ...(state.truncated ? { truncated: true } : {}),
  };
}

function normalizeValue(
  input: unknown,
  depth: number,
  state: NormalizeState,
): LogValue | undefined {
  if (++state.nodesVisited > MAX_NODES || depth > MAX_DEPTH) {
    return omit(state, 'log structure limit');
  }

  if (input === null || typeof input === 'boolean') return input;

  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : String(input);
  }

  if (typeof input === 'string') {
    // 超大原值整体省略, 不在脱敏前留下凭据的半截前缀
    return normalizeLogText(input, state);
  }

  // 只处理 JSON 值, 不调用对象的自定义转换方法.
  if (typeof input !== 'object') return undefined;

  if (state.ancestors.has(input)) return omit(state, 'circular reference');

  state.ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return normalizeArray(input, depth, state);
    }
    return normalizeObject(input, depth, state);
  } catch {
    return omit(state, 'unreadable log value');
  } finally {
    state.ancestors.delete(input);
  }
}

function normalizeArray(
  values: unknown[],
  depth: number,
  state: NormalizeState,
): LogValue[] {
  const output: LogValue[] = [];
  const length = Math.min(values.length, MAX_MEMBERS);
  for (let index = 0; index < length; index += 1) {
    const item = readOwnDataProperty(values, String(index), depth, state);
    output.push(item ?? null);
  }

  // 末尾标记说明还有未记录的数组成员.
  if (values.length > MAX_MEMBERS) {
    output.push(omit(state, 'array limit'));
  }
  return output;
}

function normalizeObject(
  value: object,
  depth: number,
  state: NormalizeState,
): Record<string, LogValue> {
  // 用 null 原型, 避免 __proto__ / constructor 之类的键污染输出
  const output: Record<string, LogValue> = Object.create(null);
  let members = 0;

  for (const key of Object.keys(value)) {
    if (++members > MAX_MEMBERS || state.nodesVisited > MAX_NODES) {
      state.truncated = true;
      break;
    }
    if (byteLength(key) > MAX_KEY_BYTES) {
      state.truncated = true;
      continue;
    }

    const child = readOwnDataProperty(value, key, depth, state);
    if (child !== undefined) {
      output[key] = child;
    }
  }

  return output;
}

/**
 * 只读取 own data property
 * 诊断日志不能执行业务对象的 getter 或 toJSON, 所以 accessor 一律记为 omitted
 */
function readOwnDataProperty(
  value: object,
  key: string,
  depth: number,
  state: NormalizeState,
): LogValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    return omit(state, 'accessor');
  }
  return normalizeValue(descriptor.value, depth + 1, state);
}

/** 按 UTF-8 字节截断, 保证不切断多字节字符, 并在末尾加截断后缀 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;

  const budget = Math.max(0, maxBytes - byteLength(TRUNCATED_SUFFIX));

  let usedBytes = 0;
  let output = '';
  for (const character of text) {
    const charBytes = byteLength(character);
    if (usedBytes + charBytes > budget) break;
    output += character;
    usedBytes += charBytes;
  }
  return output + TRUNCATED_SUFFIX;
}

interface TruncationState {
  truncated: boolean;
}

function truncateLogText(text: string, state: TruncationState, maxBytes = MAX_STRING_BYTES): string {
  const limited = truncateUtf8(text, maxBytes);
  if (limited !== text) state.truncated = true;
  return limited;
}

function truncateLogError(error: LogError, state: TruncationState): LogError {
  const limited = { ...error };
  for (const key of ['name', 'message', 'stack'] as const) {
    const text = error[key];
    if (text !== undefined) {
      limited[key] = truncateLogText(text, state);
    }
  }
  if (typeof error.code === 'string') {
    limited.code = truncateLogText(error.code, state);
  }
  if (error.cause) {
    limited.cause = truncateLogError(error.cause, state);
  }
  return limited;
}

/** 递归把所有字符串截到 MAX_STRING_BYTES, 并记录是否发生过截断 */
function truncateStringsInValue(
  value: LogValue,
  state: TruncationState,
): LogValue {
  if (typeof value === 'string') {
    return truncateLogText(value, state);
  }

  if (Array.isArray(value)) {
    return value.map(child => truncateStringsInValue(child, state));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        truncateStringsInValue(child, state),
      ]),
    );
  }

  return value;
}

/** 去掉两侧大括号, 得到一个 JSON 属性的字节数. 属性间逗号由调用方计算. */
function fieldJsonBytes(key: string, value: LogValue): number {
  return byteLength(JSON.stringify({ [key]: value })) - 2;
}

export function encodeLogWithinLimit(row: LogRow): string {
  const state: TruncationState = { truncated: row.truncated === true };

  // 先为固定字段和 truncated 标记留出空间, 再放入业务数据.
  const output: LogRow = {
    ...row,
    message: row.message === undefined ? undefined : truncateLogText(row.message, state),
    error: row.error === undefined ? undefined : truncateLogError(row.error, state),
    body: {},
    truncated: true,
  };

  limitDiagnosticContent(output, state);
  let remaining = MAX_LOG_BYTES - byteLength(JSON.stringify(output)) - 1;
  let separatorBytes = 0;

  for (const [key, originalValue] of Object.entries(row.body)) {
    let value = truncateStringsInValue(originalValue, state);
    let fieldBytes = fieldJsonBytes(key, value) + separatorBytes;

    if (fieldBytes > remaining) {
      value = omittedValue('record size limit');
      fieldBytes = fieldJsonBytes(key, value) + separatorBytes;
      state.truncated = true;
    }

    if (fieldBytes <= remaining) {
      Object.defineProperty(output.body, key, { value, enumerable: true });
      remaining -= fieldBytes;
      separatorBytes = 1;
    } else {
      state.truncated = true;
    }
  }

  if (!state.truncated) delete output.truncated;
  return `${JSON.stringify(output)}\n`;
}

function limitDiagnosticContent(output: LogRow, state: TruncationState): void {
  // 固定诊断字段也占用总预算. 先省略最深的 cause, 再省略堆栈, 保留当前错误说明.
  while (byteLength(JSON.stringify(output)) + 1 > MAX_LOG_BYTES && output.error?.cause) {
    let parent = output.error;
    while (parent.cause?.cause) {
      parent = parent.cause;
    }
    delete parent.cause;
    state.truncated = true;
  }
  if (byteLength(JSON.stringify(output)) + 1 > MAX_LOG_BYTES && output.error?.stack) {
    delete output.error.stack;
    state.truncated = true;
  }
  if (byteLength(JSON.stringify(output)) + 1 > MAX_LOG_BYTES) {
    if (output.message !== undefined) {
      output.message = truncateLogText(output.message, state, 512);
    }
    if (output.error) {
      output.error = { message: truncateLogText(output.error.message, state, 512) };
    }
    state.truncated = true;
  }
}
