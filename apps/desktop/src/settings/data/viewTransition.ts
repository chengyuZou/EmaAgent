// 存储页列表与详情的共享元素过渡. 旧帧与新帧各只能有一个同名元素,
// 调用方在 update 内交接名称. 不支持 View Transitions 时直接执行状态更新.
import { flushSync } from 'react-dom';

export const MORPH_NAME = 'ema-morph-target';

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

export function morphTransition(update: () => void): Promise<void> | undefined {
  const doc = document as ViewTransitionCapableDocument;
  if (typeof doc.startViewTransition !== 'function') {
    update();
    return undefined;
  }
  // React 18 的自动批处理会把状态更新挤到过渡快照之后,flushSync 保证新旧两帧正确。
  return doc.startViewTransition(() => flushSync(update)).finished;
}
