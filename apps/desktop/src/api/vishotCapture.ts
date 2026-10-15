import { rpcClient, readRpcVoid } from './client.js';

// 按切换顺序提交, 防止较早的 HTTP 请求晚到而把目标改回旧 Session.
let pending: Promise<void> = Promise.resolve();

export function setVishotCaptureSession(sessionId: string | null): Promise<void> {
  const request = pending.then(() => readRpcVoid(
    rpcClient.api['vishot-capture'].session.$put({ json: { sessionId } }),
  ));
  pending = request.catch(() => undefined);
  return request;
}
