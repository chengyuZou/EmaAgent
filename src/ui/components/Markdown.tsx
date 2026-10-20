// 聊天, 文件预览与工具结果共用此入口. raw HTML 先清洗, 再交给 KaTeX 和高亮器.
// 自定义 URL 处理会接管 href/src 的协议判断, 调用方必须拒绝脚本等不允许的协议.
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown';
import { createContext, memo, useContext, type ReactNode } from 'react';
import type { Extension } from 'mdast-util-from-markdown';
import type { Plugin } from 'unified';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { CodeViewer } from './codeViewer.js';
import { MermaidBlock } from './mermaidBlock.js';
import { MarkdownLink } from './markdownLink.js';

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

interface MarkdownRenderers {
  /** 只覆盖传入的标签, 其他标签继续使用 Markdown 的默认显示方式. */
  readonly components: Components;
  /** 替换 URL 处理时, 调用方必须拒绝脚本等不允许的协议. HTML 的其他清洗规则保持不变. */
  readonly urlTransform: UrlTransform;
}

const CustomMarkdownRenderers = createContext<MarkdownRenderers | null>(null);

/**
 * 让 desktop 为 Markdown 提供图片点击, 音频卡片和文件链接打开操作, UI 包不导入桌面的媒体组件或文件侧栏.
 * components 负责显示和点击, urlTransform 负责允许的地址; 文件读取和导航仍由调用方处理.
 * 作用范围内的 Markdown 都使用这些处理方式, 未设置 Provider 的 Markdown 保持默认行为.
 */
export function MarkdownRendererProvider({ children, components, urlTransform }: MarkdownRenderers & {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <CustomMarkdownRenderers.Provider value={{ components, urlTransform }}>
      {children}
    </CustomMarkdownRenderers.Provider>
  );
}

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

// raw HTML 安全边界: 剥离布局类属性, 模型/Skill/文件内容都不可信

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

// Windows 文件路径和 Base64 图片需要先交给自定义 urlTransform 判断, 否则会被默认协议规则提前删除.
// 移除 href/src 的协议过滤, 脚本标签, 事件和布局属性仍按原规则清洗.
const { href: _hrefProtocols, src: _srcProtocols, ...otherProtocols } = markdownSanitizeSchema.protocols ?? {};
const customUrlSanitizeSchema = { ...markdownSanitizeSchema, protocols: otherProtocols };

const markdownComponents: Components = {
  pre({ node, children, ...props }) {
    const streaming = useContext(StreamingMarkdown);
    const code = node?.children[0];
    if (!node) return <pre {...props}>{children}</pre>;

    function readText(child: NonNullable<typeof node>['children'][number]): string {
      if (child.type === 'text') return child.value;
      if (child.type === 'element') return child.children.map(readText).join('');
      return '';
    }

    const source = node.children.map(readText).join('').replace(/\n$/, '');
    let language = 'text';
    if (code?.type === 'element' && code.tagName === 'code') {
      const classes = code.properties.className;
      if (Array.isArray(classes)) {
        const languageClass = classes.find(value => String(value).startsWith('language-'));
        if (languageClass) language = String(languageClass).slice('language-'.length);
      }
      if (language === 'mermaid') {
        return (
          <MermaidBlock
            source={source}
            pending={streaming && code.properties.dataMermaidClosed !== 'true'}
          />
        );
      }
    }
    return <CodeViewer source={source} language={language} />;
  },
  a({ node: _node, ...props }) {
    return <MarkdownLink {...props} />;
  },
};

export const Markdown = memo(function Markdown({ source, className, streaming = false }: MarkdownProps): JSX.Element {
  const renderers = useContext(CustomMarkdownRenderers);
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
            // 先清洗 raw HTML, 再运行可信渲染器. 代码高亮由 CodeViewer 负责.
            [rehypeSanitize, renderers ? customUrlSanitizeSchema : markdownSanitizeSchema],
            rehypeKatex,
          ]}
          components={renderers ? { ...markdownComponents, ...renderers.components } : markdownComponents}
          urlTransform={renderers?.urlTransform}
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
