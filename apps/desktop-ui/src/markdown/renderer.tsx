/**
 * 将模型返回的 Markdown 渲染为安全内容，并在清洗后补充公式与代码高亮。
 * 流程：Markdown -> raw HTML -> 安全清洗 -> KaTeX -> highlight.js -> React。
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
// highlight.js 主题:用 --ema-syntax-* token,亮暗双模自动(替代 github-dark.css)。
import '../styles/hljs-theme.css';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MarkdownProps {
  /** Raw markdown source string. */
  source: string;
  /** Streaming mode: skip re-process on clean frame ends. */
  streaming?: boolean;
  /** Additional CSS class for the wrapper div. */
  className?: string;
}

// ── Raw HTML 安全边界 ───────────────────────────────────────────────────────

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
    // 只允许 fenced code 的 language-* 类，供可信的代码高亮器识别语言。
    code: [
      ...removeLayoutAttributes(defaultSchema.attributes?.code as SanitizeAttribute[] | undefined),
      ['className', /^language-[\w-]+$/],
    ],
    // raw span/div 不接受任何布局属性；KaTeX 在清洗后运行，不受影响。
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

// ── Component ─────────────────────────────────────────────────────────────────

export function Markdown({ source, className }: MarkdownProps): JSX.Element {
  if (!source) {
    return <div className="markdown-content" />;
  }

  try {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          // 先清洗模型、Skill 和文件提供的 raw HTML，再运行可信渲染器。
          [rehypeSanitize, markdownSanitizeSchema],
          rehypeKatex,
          rehypeHighlight,
        ]}
        components={markdownComponents}
        className={`markdown-content${className ? ` ${className}` : ''}`}
      >
        {source}
      </ReactMarkdown>
    );
  } catch {
    return <pre className="markdown-fallback">{source}</pre>;
  }
}
