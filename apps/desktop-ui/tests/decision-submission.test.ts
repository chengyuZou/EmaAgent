// 测试决定提交失败时保留卡片，成功或后端已处理时才允许出队。
import { describe, expect, it, vi } from 'vitest';
import { submitDecision } from '../src/decision/decision-submission.js';
import { SidecarApiError } from '../src/api/sidecar-client.js';

describe('submitDecision', () => {
  it('提交成功后执行出队回调', async () => {
    const onSuccess = vi.fn();
    await expect(submitDecision(async () => ({ ok: true }), onSuccess)).resolves.toBeUndefined();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('网络失败时返回错误且不出队', async () => {
    const onSuccess = vi.fn();
    const error = await submitDecision(async () => {
      throw new Error('sidecar unreachable');
    }, onSuccess);

    expect(error).toBe('sidecar unreachable');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('404 表示后端已不再等待，清除本地过期副本', async () => {
    const onSuccess = vi.fn();
    const error = await submitDecision(async () => {
      throw new SidecarApiError(404, '{"error":"not_found_or_expired"}');
    }, onSuccess);

    expect(error).toBeUndefined();
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
