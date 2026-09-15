// 为文件预览和逐行差异提供同一套基于文件扩展名的 highlight.js 语法高亮。
import hljs from 'highlight.js';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  json: 'json',
  jsonl: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
};

function languageForPath(path: string): string | null {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const extension = fileName.includes('.')
    ? fileName.split('.').pop()?.toLowerCase()
    : fileName.toLowerCase();
  const language = extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
  return language && hljs.getLanguage(language) ? language : null;
}

function escapeHtml(source: string): string {
  return source
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** 完整文件可在扩展名未知时自动识别；只执行一次，不影响滚动性能。 */
export function highlightFile(source: string, path: string): string {
  const language = languageForPath(path);
  try {
    return language
      ? hljs.highlight(source, { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(source).value;
  } catch {
    return escapeHtml(source);
  }
}

/** Diff 按行渲染；只对已知扩展名高亮，避免逐行自动探测产生误判和卡顿。 */
export function highlightDiffLine(source: string, path: string): string {
  const language = languageForPath(path);
  if (!language) return escapeHtml(source);
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(source);
  }
}
