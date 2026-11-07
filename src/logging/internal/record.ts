import process from 'node:process';
import type { LogError, LogInput, LogRow } from '../types.js';
import { normalizeLogBody, normalizeLogText } from './limit.js';

export function createLogRow(input: LogInput): LogRow {
  const state = { truncated: false };
  const message = input.message === undefined ? undefined : normalizeLogText(input.message, state);
  const error = input.error === undefined ? undefined : extractLogError(input.error, state);
  const normalized = normalizeLogBody(input.body ?? {});
  return {
    time: new Date().toISOString(),
    level: input.level,
    target: input.target,
    pid: process.pid,
    event: input.event,
    message,
    error,
    body: normalized.body,
    ...(state.truncated || normalized.truncated ? { truncated: true } : {}),
  };
}

function extractLogError(
  value: unknown,
  state: { truncated: boolean },
  ancestors = new Set<object>(),
): LogError {
  if (value === null || typeof value !== 'object') {
    return { message: normalizeLogText(String(value), state) };
  }
  if (ancestors.has(value) || ancestors.size >= 6) {
    state.truncated = true;
    return { message: '[omitted: error cause limit]' };
  }

  ancestors.add(value);
  try {
    // SDK 错误可能携带完整请求和响应. 只提取这些诊断字段, 不遍历 SDK 对象.
    const read = (key: string): unknown => value instanceof Error
      ? Reflect.get(value, key)
      : Object.getOwnPropertyDescriptor(value, key)?.value;
    const message = read('message');
    const error: LogError = {
      message: normalizeLogText(typeof message === 'string' ? message : '[non-Error thrown value]', state),
    };
    for (const key of ['name', 'stack'] as const) {
      const text = read(key);
      if (typeof text === 'string') {
        error[key] = normalizeLogText(text, state);
      }
    }

    const code = read('code');
    if (typeof code === 'string') {
      error.code = normalizeLogText(code, state);
    } else if (typeof code === 'number' && Number.isFinite(code)) {
      error.code = code;
    }

    const status = read('status');
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      error.status = status;
    }

    const cause = read('cause');
    if (cause !== undefined) {
      error.cause = extractLogError(cause, state, ancestors);
    }
    return error;
  } catch {
    state.truncated = true;
    return { message: '[omitted: unreadable error]' };
  } finally {
    ancestors.delete(value);
  }
}
