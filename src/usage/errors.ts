// 用量记录校验失败时交给 onError 诊断的稳定错误类型。
import type { UsageRecordIssue } from './validate.js';

/** 记录未通过 validateUsageRecord；观测链路拒绝写入并转交诊断。 */
export class UsageRecordValidationError extends Error {
  constructor(readonly issues: readonly UsageRecordIssue[]) {
    super(
      `invalid usage record: ${
        issues.map((issue) => `${issue.field}.${issue.code}`).join(', ')
      }`,
    );
    this.name = 'UsageRecordValidationError';
  }
}
