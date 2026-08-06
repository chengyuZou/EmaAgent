// 校验调用级用量记录，拒绝会在存储层触发约束错误或污染统计的非法字段。
import type {
  UsageCapability,
  UsageRecord,
  UsageRecordStatus,
} from './types.js';

export type UsageRecordIssueCode =
  | 'empty'
  | 'unknown'
  | 'not_finite'
  | 'negative'
  | 'quantity_unit_mismatch'
  | 'completed_with_error'
  | 'turn_without_session';

export type UsageRecordIssueField =
  | 'id'
  | 'sessionId'
  | 'turnId'
  | 'providerId'
  | 'modelId'
  | 'capability'
  | 'status'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'quantity'
  | 'unit'
  | 'durationMs'
  | 'errorCode'
  | 'createdAt';

export interface UsageRecordIssue {
  readonly field: UsageRecordIssueField;
  readonly code: UsageRecordIssueCode;
  readonly message: string;
}

const CAPABILITIES: readonly UsageCapability[] =
  ['llm', 'vision', 'embed', 'rerank', 'stt', 'tts'];

const STATUSES: readonly UsageRecordStatus[] =
  ['completed', 'failed', 'cancelled'];

const TOKEN_FIELDS: readonly (
  'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheWriteInputTokens'
)[] = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'];

/**
 * 校验组装后的用量记录并一次性返回全部问题；不在调用链上抛错，
 * 由 reportUsage 拒绝写入并转交 onError 诊断。
 */
export function validateUsageRecord(record: UsageRecord): readonly UsageRecordIssue[] {
  const issues: UsageRecordIssue[] = [];

  checkNonEmpty(issues, 'id', record.id);
  checkNonEmpty(issues, 'providerId', record.providerId);
  checkNonEmpty(issues, 'modelId', record.modelId);
  if (record.sessionId !== null) checkNonEmpty(issues, 'sessionId', record.sessionId);
  if (record.turnId !== null) checkNonEmpty(issues, 'turnId', record.turnId);

  if (record.turnId !== null && record.sessionId === null) {
    issues.push({
      field: 'sessionId',
      code: 'turn_without_session',
      message: 'turnId requires a sessionId',
    });
  }

  if (!CAPABILITIES.includes(record.capability)) {
    issues.push({
      field: 'capability',
      code: 'unknown',
      message: `unknown capability "${String(record.capability)}"`,
    });
  }

  if (!STATUSES.includes(record.status)) {
    issues.push({
      field: 'status',
      code: 'unknown',
      message: `unknown status "${String(record.status)}"`,
    });
  }

  if (record.status === 'completed' && record.errorCode !== null) {
    issues.push({
      field: 'errorCode',
      code: 'completed_with_error',
      message: 'completed records must not carry an errorCode',
    });
  }

  for (const field of TOKEN_FIELDS) {
    const value = record[field];
    if (value !== null) checkNonNegativeNumber(issues, field, value);
  }

  if (record.quantity !== null) checkNonNegativeNumber(issues, 'quantity', record.quantity);

  if ((record.quantity === null) !== (record.unit === null)) {
    issues.push({
      field: record.unit === null ? 'unit' : 'quantity',
      code: 'quantity_unit_mismatch',
      message: 'quantity and unit must be both present or both absent',
    });
  }

  checkNonNegativeNumber(issues, 'durationMs', record.durationMs);
  checkFiniteNumber(issues, 'createdAt', record.createdAt);

  return issues;
}

function checkNonEmpty(
  issues: UsageRecordIssue[],
  field: UsageRecordIssueField,
  value: string,
): void {
  if (value.trim().length === 0) {
    issues.push({
      field,
      code: 'empty',
      message: `${field} must not be empty`,
    });
  }
}

function checkNonNegativeNumber(
  issues: UsageRecordIssue[],
  field: UsageRecordIssueField,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    issues.push({
      field,
      code: 'not_finite',
      message: `${field} must be a finite number`,
    });
  } else if (value < 0) {
    issues.push({
      field,
      code: 'negative',
      message: `${field} must not be negative`,
    });
  }
}

function checkFiniteNumber(
  issues: UsageRecordIssue[],
  field: UsageRecordIssueField,
  value: number,
): void {
  if (!Number.isFinite(value)) {
    issues.push({
      field,
      code: 'not_finite',
      message: `${field} must be a finite number`,
    });
  }
}
