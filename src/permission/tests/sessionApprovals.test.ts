import { afterEach, expect, it } from 'vitest';
import { clearSessionApprovals, getSessionApprovals, rememberSessionApproval } from '../rules/sessionApprovals.js';

afterEach(() => clearSessionApprovals('approval-test'));

it('按 Session 保存并去重, 支持只指定工具名和字面条件', () => {
  rememberSessionApproval('approval-test', { toolName: 'Read' });
  rememberSessionApproval('approval-test', { toolName: 'Read' });
  rememberSessionApproval('approval-test', { toolName: 'Bash', condition: 'echo "a(b)"' });
  expect(getSessionApprovals('approval-test')).toEqual([
    { toolName: 'Read' }, { toolName: 'Bash', condition: 'echo "a(b)"' },
  ]);
  expect(getSessionApprovals('other')).toEqual([]);
  clearSessionApprovals('approval-test');
  expect(getSessionApprovals('approval-test')).toEqual([]);
});
