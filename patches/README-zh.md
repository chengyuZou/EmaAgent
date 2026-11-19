# 依赖补丁

[English](./README.md)

这些补丁修改了桌面端界面使用的三个已安装依赖. 根目录 [package.json](../package.json) 在 `pnpm.patchedDependencies` 中登记了它们的精确版本, [pnpm-lock.yaml](../pnpm-lock.yaml) 记录了补丁路径与哈希. pnpm 会在安装依赖时自动应用它们.

## Live2D 加载, 清理与表情

[@laplace.live/pixijs-live2d 0.6.1](./@laplace.live__pixijs-live2d@0.6.1.patch) 修复模型在 Pixi 8 下的加载与销毁清理问题, 并在自动眨眼期间保留表情中设置的眼部姿态.

该补丁修改了依赖包中的 `dist/index.js`:

- FileLoader 在校验并上传模型文件之前先注册清理逻辑. 当模型初始化失败被销毁时, 会释放其设置 URL 与已经创建的资源 URL; 成功加载的模型则在内部模型销毁时统一释放.
- 纹理加载显式指定 Pixi 的 `loadTextures` 解析器. 压缩包资源使用不带图片扩展名的 Blob URL, 因此解析器选择不能依赖文件扩展名.
- 纹理释放与模型销毁允许内部模型尚未创建的情况. 这样清理流程可以顺利完成, 不会用访问未定义属性的报错掩盖原本的加载错误.
- 每一帧中, 表情会在自动眨眼之后再应用. 因此表情里显式指定的眼部数值会在眨眼更新后生效. 控制眨眼的动作仍保留依赖原本的眨眼检查.

[Live2DStage](../src/live2d-react/Live2DStage.tsx) 负责加载模型压缩包, 上报加载失败并销毁未完成创建的模型. 应用侧初始化, 资源归属与正式构建的 CSP 约束见 [Live2D 模块](../src/live2d-react/README-zh.md).

## 文件树滚动

[@pierre/trees 1.0.0-beta.6](./@pierre__trees@1.0.0-beta.6.patch) 修复虚拟化文件树在视口高度测量与非整数高度滚动上的问题.

该依赖通过测量视口高度来决定某个获得焦点的行需要滚动多少距离. 原有测量方式把原生水平滚动条占用的高度算进了可用于显示文件行的空间, 可能导致最后一行仍被水平滚动条遮住一部分.

该补丁修改了 `dist/render/focusHelpers.js` 中的两处测量逻辑:

- 直接读取高度时使用 `clientHeight`, 不再使用 `getBoundingClientRect().height`.
- ResizeObserver 回调中使用 `contentRect.height`, 不再使用 `borderBoxSize`.

同时还在 `dist/utils/cssWrappers.js` 的共享核心样式中补充了如下规则:

```css
:host([data-file-tree-virtualized="true"]) {
  max-height: round(down, 100%, 1px);
}
```

将最大高度向下取整到整数像素, 用于解决容器高度带小数时滚动到底部的绘制抖动. 使用 `max-height` 可以让文件树继续随父容器自适应, 既不会拉伸刻意设小的文件树, 也不会把测量高度写死.

共享依赖样式会同时作用于桌面端的[变更审阅树](../apps/desktop/src/chat/sidePanel/tabs/review/reviewFileTree.tsx), [工作区文件树](../apps/desktop/src/chat/sidePanel/tabs/files/workspaceFileTree.tsx)和 [Memory 文件树](../apps/desktop/src/settings/memory/memoryFileTree.tsx).

## Mermaid ELK 间距

[@mermaid-js/layout-elk 0.2.2](./@mermaid-js__layout-elk@0.2.2.patch) 将 Mermaid 的节点间距与层级间距透传给 ELK. 若不做这两项赋值, 修改流程图间距不会生效到对应的 ELK 布局选项.

该补丁在依赖打包后的渲染器布局配置中增加了两项赋值:

| Mermaid 布局参数 | ELK 选项 |
| --- | --- |
| `data4Layout.nodeSpacing` | `elk.spacing.nodeNode` |
| `data4Layout.rankSpacing` | `elk.layered.spacing.nodeNodeBetweenLayers` |

[mermaidRender.ts](../src/ui/components/mermaidRender.ts) 负责加载 ELK 渲染器并提供应用的流程图默认参数. 打上补丁后, 这些设置 (包括支持的图表级间距覆盖) 即可作用于最终生成的节点位置.

## 升级已打补丁的依赖

升级到新版本并继续保留补丁前, 先核对上游新版是否已经修复同一问题. 若不再需要, 应直接移除补丁; 否则需要按 pnpm 的 patch 流程基于新版本重新生成, 因为打包后的文件名和上下文代码可能已经变化.

请通过 pnpm 保持补丁文件, 根目录 `pnpm.patchedDependencies` 条目与锁文件同步. 仅手工修改 `node_modules` 中已安装的文件, 无法在重新安装或发布构建中保留改动.

针对 Live2D, 运行:

```sh
pnpm --filter @ema-agent/desktop test:live2d-release
```

该浏览器回归会按配置好的发布 CSP 加载内置 Ema 模型. 将 `EMA_LIVE2D_SAMPLES_PATH` 指向 Cubism 示例资源目录后, 还会一并检查 Hiyori, Haru, Wanko 和 Ren. 它会验证渲染, 表情, 动作, 模型切换以及加载失败或取消后的资源清理. 原生窗口行为需另行在安装版应用中检查.

针对 Mermaid, 运行:

```sh
pnpm --filter @ema-agent/ui test tests/mermaidRender.test.ts tests/mermaidIntegration.test.ts
```

其中集成测试会调用真实的 Mermaid 和 ELK 包, 检查增大 `rankSpacing` 后节点位置确实发生变化. 测试中模拟的 SVG 文本尺寸不能代替实际浏览器中的视觉呈现验证.

针对文件树, 请在实际桌面 WebView 中检查超长文件名, 水平滚动条以及非整数高度容器的场景. 先滚动并用键盘焦点移到最后一行, 再调整面板大小, 确认该行保持可见且底部没有抖动; 同时在实际页面中核对 Mermaid 图表观感.
