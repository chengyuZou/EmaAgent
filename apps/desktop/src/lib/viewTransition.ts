// View Transitions 封装:被点块 ⇄ 全幅视图的共享元素 morph(水滴扩散/逆扩散)。
// 用法:源块与全幅容器都挂 style={{ viewTransitionName: MORPH_NAME }}(同一时刻只开一个),
// 状态切换经 morphTransition(() => setX(...)) 触发;不支持的环境降级为瞬切。
import { flushSync } from 'react-dom';

export const MORPH_NAME = 'ema-morph-target';

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

export function morphTransition(update: () => void): void {
  const doc = document as ViewTransitionCapableDocument;
  if (typeof doc.startViewTransition !== 'function') {
    update();
    return;
  }
  // React 18 的自动批处理会把状态更新挤到过渡快照之后,flushSync 保证新旧两帧正确。
  doc.startViewTransition(() => flushSync(update));
}
