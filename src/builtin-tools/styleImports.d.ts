// Vite 将公开的 Diff 样式资产作为字符串交给官方 shadow root 接口.
declare module '@ema-agent/builtin-tools/fileDiff.css?inline' {
  const css: string;
  export default css;
}
