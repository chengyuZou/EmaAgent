import type { SqliteDb } from './database.js';

/**
 * 即使当前 SQLite 构建支持数万个变量，也限制单批 ID 数量，避免生成巨型 SQL。
 * 400 同时兼容传统 999 变量上限下“每个 ID 使用两次”的查询。
 */
export const SQLITE_ID_BATCH_HARD_LIMIT = 400;
const SQLITE_FALLBACK_VARIABLE_LIMIT = 999;
const variableLimitCache = new WeakMap<SqliteDb, number>();

export interface SqliteIdBatchOptions {
  /** 同一个 ID 在 SQL 中重复绑定的次数。 */
  occurrencesPerId?: number;
  /** 除 ID 外，SQL 还需要绑定的固定参数数量。 */
  fixedParameterCount?: number;
}

export class SqliteVariableLimitError extends Error {
  readonly code = 'storage/sqlite-variable-limit-insufficient';

  constructor(readonly variableLimit: number, readonly requiredMinimum: number) {
    super(
      `SQLite variable limit ${variableLimit} is below the required minimum ${requiredMinimum}`,
    );
    this.name = 'SqliteVariableLimitError';
  }
}

/**
 * 去重并分批，单批大小同时受 SQLite 实际变量上限和固定 400 ID 上限约束。
 */
export function createSqliteIdBatches(
  db: SqliteDb,
  ids: readonly string[],
  options: SqliteIdBatchOptions = {},
): string[][] {
  const occurrencesPerId = positiveInteger(options.occurrencesPerId ?? 1, 'occurrencesPerId');
  const fixedParameterCount = nonNegativeInteger(
    options.fixedParameterCount ?? 0,
    'fixedParameterCount',
  );
  const variableLimit = sqliteVariableLimit(db);
  const available = variableLimit - fixedParameterCount;
  if (available < occurrencesPerId) {
    throw new SqliteVariableLimitError(
      variableLimit,
      fixedParameterCount + occurrencesPerId,
    );
  }

  const batchSize = Math.min(
    SQLITE_ID_BATCH_HARD_LIMIT,
    Math.floor(available / occurrencesPerId),
  );
  const uniqueIds = [...new Set(ids)];
  const batches: string[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    batches.push(uniqueIds.slice(offset, offset + batchSize));
  }
  return batches;
}

export function sqliteVariableLimit(db: SqliteDb): number {
  const cached = variableLimitCache.get(db);
  if (cached !== undefined) return cached;

  let limit = SQLITE_FALLBACK_VARIABLE_LIMIT;
  let rows: Array<{ compile_options?: unknown }>;
  try {
    rows = db.pragma('compile_options') as Array<{ compile_options?: unknown }>;
  } catch {
    variableLimitCache.set(db, limit);
    return limit;
  }
  for (const row of rows) {
    if (typeof row.compile_options !== 'string') continue;
    const match = /^MAX_VARIABLE_NUMBER=(\d+)$/.exec(row.compile_options);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) limit = parsed;
    break;
  }
  variableLimitCache.set(db, limit);
  return limit;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}
