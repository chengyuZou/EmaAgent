/**
 * 聊天、文件预览、Memory 和 Tool UI 共用的安全 Markdown, 支持公式、代码高亮和 Mermaid.
 * 流程: Markdown -> raw HTML -> 安全清洗 -> KaTeX/highlight -> React/Mermaid.
 *
 * 位于 ui 包的原因: desktop 聊天/文件预览与 builtin-tools 的 Tool UI 都要渲染
 * Markdown, 而 Tool UI 只允许消费 @ema-agent/ui. 排版样式是全局 .markdown-content
 * (src/ui/styles/primitives/markdown.css), KaTeX 样式由桌面入口引入.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import { createContext, memo, useContext } from 'react';
import type { Extension } from 'mdast-util-from-markdown';
import type { Plugin } from 'unified';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { MermaidBlock } from './mermaidBlock.js';

declare module 'unified' {
  interface Data {
    fromMarkdownExtensions?: Array<Extension[] | Extension>;
  }
}

export interface MarkdownProps {
  /** Markdown 原文. */
  source: string;
  /** 追加到外层 div 的 class. */
  className?: string;
  /** 流式内容中的未闭合 Mermaid 代码块只显示等待状态, 不尝试绘图. */
  streaming?: boolean;
}

const StreamingMarkdown = createContext(false);

// 使用现有 micromark 的围栏 token, 不重复解析 Markdown 或用正则猜测闭合状态.
const mermaidFences: Extension = {
  exit: {
    codeFencedFenceSequence() {
      const top = this.stack.at(-1)!;
      const code = top.type === 'code' ? top : this.stack.at(-2);
      if (code?.type !== 'code') return;
      const properties = (code.data ??= {}).hProperties ??= {};
      properties.dataMermaidClosed = properties.dataMermaidClosed === 'false' ? 'true' : 'false';
    },
  },
};

const remarkMermaidFences: Plugin = function () {
  const extensions = this.data().fromMarkdownExtensions ??= [];
  extensions.push(mermaidFences);
};

// ── raw HTML 安全边界: 剥离布局类属性, 模型/Skill/文件内容都不可信 ────────────

type SanitizeAttribute = string | [string, ...Array<unknown>];

function attributeName(attribute: SanitizeAttribute): string {
  return typeof attribute === 'string' ? attribute : attribute[0];
}

function removeLayoutAttributes(attributes: SanitizeAttribute[] | undefined): SanitizeAttribute[] {
  return (attributes ?? []).filter((attribute) => {
    const name = attributeName(attribute);
    return name !== 'style' && name !== 'id' && name !== 'className' && name !== 'class';
  });
}

const safeAttributes = Object.fromEntries(
  Object.entries(defaultSchema.attributes ?? {}).map(([tagName, attributes]) => [
    tagName,
    removeLayoutAttributes(attributes as SanitizeAttribute[]),
  ]),
);

export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...safeAttributes,
    '*': removeLayoutAttributes(defaultSchema.attributes?.['*'] as SanitizeAttribute[] | undefined),
    // 只放行 fenced code 的 language-* 类, 供代码高亮器识别语言.
    code: [
      ...removeLayoutAttributes(defaultSchema.attributes?.code as SanitizeAttribute[] | undefined),
      ['className', /^language-[\w-]+$/],
      'dataMermaidClosed',
    ],
    // raw span/div 不接受任何布局属性; KaTeX 在清洗后运行, 不受影响.
    span: [],
    div: [],
    a: removeLayoutAttributes(defaultSchema.attributes?.a as SanitizeAttribute[] | undefined),
    details: [],
    summary: [],
    sup: [],
    sub: [],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details', 'summary',
  ],
};

const markdownComponents: Components = {
  pre({ node, children, ...props }) {
    const streaming = useContext(StreamingMarkdown);
    const code = node?.children[0];
    if (code?.type === 'element' && code.tagName === 'code'
      && Array.isArray(code.properties.className)
      && code.properties.className.includes('language-mermaid')) {
      const source = code.children
        .filter(child => child.type === 'text')
        .map(child => child.value)
        .join('')
        .replace(/\n$/, '');
      return (
        <MermaidBlock
          source={source}
          pending={streaming && code.properties.dataMermaidClosed !== 'true'}
        />
      );
    }
    return <pre {...props}>{children}</pre>;
  },
  a({ node: _node, href, children, ...props }) {
    const external = typeof href === 'string' && /^https?:\/\//i.test(href);
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ source, className, streaming = false }: MarkdownProps): JSX.Element {
  if (!source) {
    return <div className="markdown-content" />;
  }

  try {
    return (
      <StreamingMarkdown.Provider value={streaming}>
        <ReactMarkdown
          remarkPlugins={[remarkMath, remarkGfm, remarkMermaidFences]}
          rehypePlugins={[
            rehypeRaw,
            // 先清洗 raw HTML, 再运行可信渲染器(KaTeX/highlight).
            [rehypeSanitize, markdownSanitizeSchema],
            rehypeKatex,
            [rehypeHighlight, { plainText: ['mermaid'] }],
          ]}
          components={markdownComponents}
          className={`markdown-content${className ? ` ${className}` : ''}`}
        >
          {source}
        </ReactMarkdown>
      </StreamingMarkdown.Provider>
    );
  } catch {
    return <pre className="markdown-fallback">{source}</pre>;
  }
});
