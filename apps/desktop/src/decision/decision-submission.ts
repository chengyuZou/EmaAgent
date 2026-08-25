// 统一判断一次用户决定提交后应当出队、保留重试还是清理过期副本。
import { SidecarApiError } from '../api/sidecar-client.js';

/** 返回错误文案表示后端仍在等待，调用方必须保留原卡片。 */
export async function submitDecision(
  operation: () => Promise<unknown>,
  onSuccess: () => void,
): Promise<string | undefined> {
  try {
    await operation();
    onSuccess();
    return undefined;
  } catch (cause: unknown) {
    // 另一窗口或 resolved SSE 可能已经完成同一请求；404 表示后端不再等待，
    // 本窗口应清掉过期副本，而不是让用户永远重试。
    if (cause instanceof SidecarApiError && cause.status === 404) {
      onSuccess();
      return undefined;
    }
    return cause instanceof Error ? cause.message : '提交失败，请重试';
  }
}
