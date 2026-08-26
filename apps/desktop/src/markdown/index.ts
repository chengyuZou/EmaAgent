// `./markdown` 渲染入口(F-035)。
// 之前 package.json 声明了该导出但无 index.ts,tsc 不生成 dist/markdown/index.js,
// 外部消费者 import 会运行时报模块不存在。这里 re-export Markdown 渲染组件,
// 让声明的导出真实可用。
export { Markdown } from './renderer.js';
export type { MarkdownProps } from './renderer.js';
