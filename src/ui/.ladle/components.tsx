// Ladle 预览的全局 Provider:组件里的 animate-* 类(ema-fade-in 等)引用的
// @keyframes 住在 desktop 的 styles/foundation/keyframes.css,Ladle 默认不加载,
// 这里单源引入,让 stories 里的入场动画真实播放。仅开发环境,不进产品包。
import type { GlobalProvider } from '@ladle/react';
import '../../apps/desktop/src/styles/foundation/keyframes.css';

export const Provider: GlobalProvider = ({ children }) => <>{children}</>;
