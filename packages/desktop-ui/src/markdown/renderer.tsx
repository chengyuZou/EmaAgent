/**
 * Markdown renderer — React component that transforms Markdown → safe HTML.
 *
 * Pipeline:
 *   markdown string
 *     → remark-parse → remark-math → remark-gfm
 *     → remark-rehype
 *     → rehype-raw → rehype-katex → rehype-sanitize
 *     → rehype-stringify
 *     → dangerouslySetInnerHTML
 *
 * Note: Shiki syntax highlighting is temporarily disabled due to a
 * `rehype-shiki` git dependency install issue.
 */
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MarkdownProps {
  /** Raw markdown source string. */
  source: string;
  /** Streaming mode: skip re-process on clean frame ends. */
  streaming?: boolean;
  /** Additional CSS class for the wrapper div. */
  className?: string;
}

// ── Sanitize schema (allow KaTeX + Shiki classes) ────────────────────────────

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className'],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'style'],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className'],
    ],
    // KaTeX elements
    math:  [['display']],
    mjx:   [['class']],
    // Allow target on links
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ['target', 'rel'],
    ],
    // Details/summary for collapsible content
    details: [],
    summary: [],
    sup: [],
    sub: [],
  },
  // Allow KaTeX + Shiki specific tags
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'mfrac', 'msqrt', 'mtable', 'mtr', 'mtd', 'munder', 'mover',
    'details', 'summary',
  ],
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
          rehypeKatex,
          [rehypeSanitize, sanitizeSchema],
        ]}
        className={`markdown-content${className ? ` ${className}` : ''}`}
      >
        {source}
      </ReactMarkdown>
    );
  } catch {
    return <pre className="markdown-fallback">{source}</pre>;
  }
}
