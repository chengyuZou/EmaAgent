# Trees 滚动视口补丁

`@pierre__trees@1.0.0-beta.6.patch` 修正审查文件树的可见高度测量. 原库用 `getBoundingClientRect().height` 和 ResizeObserver 的 `borderBoxSize`, 把原生横向滚动条也计入了可见高度. 库随后按过大的视口高度限制 `scrollTop`, 导致最后一行无法完整滚到横向滚动条上方.

`dist/render/focusHelpers.js` 的两处尺寸读取改为: 首次测量使用 `clientHeight`, ResizeObserver 更新使用 `contentRect.height`.

补丁还在 `dist/utils/cssWrappers.js` 的共用核心样式中, 给虚拟树宿主加上 `max-height: round(down, 100%, 1px)`. 填满父容器的树会向下取整到整数像素, 避免小数高度时滚到底继续向下滚出现绘制晃动; 宿主仍随父容器变化, 不把一次测量的高度固定下来. 使用最大高度限制而不是强制设置高度, 不把使用方主动指定的较小高度撑大. 核心样式由 React、普通 DOM 和预渲染入口共用, 使用方不用重复写取整规则.

树模型、虚拟化、路径标识和滚动算法仍然由原库维护, 不拦截 wheel 或覆盖鼠标响应. pnpm 9 通过根 `package.json` 的 `pnpm.patchedDependencies` 和锁文件应用补丁, 不依赖手动修改 node_modules.

