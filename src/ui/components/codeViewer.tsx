import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { standardKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, lineNumbers as codeLineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import hljs from 'highlight.js/lib/common';
import { IconButton } from './IconButton.js';
import { Tooltip } from './Tooltip.js';

export interface CodeViewerProps {
  /** 完整文本. 可视区只显示其中一部分, 复制全文不受可视区限制. */
  readonly source: string;
  /** 使用代码围栏的语言名, 未识别的语言按纯文本显示. */
  readonly language?: string;
  /** 文件读取结果中的原始行号, 与 source 的行逐项对应. */
  readonly lineNumbers?: readonly string[];
  /** 外层已经提供标题与复制操作时, 只显示文本区域. */
  readonly embedded?: boolean;
  /** 默认自动折行. 工具输出关闭折行时, 横向滚动条位于文本可视区底部. */
  readonly wrapLines?: boolean;
}

const appearance = EditorView.theme({
  '&': {
    color: 'var(--ema-code-text, var(--ema-syntax-text, var(--ema-text-primary)))',
    backgroundColor: 'transparent',
    fontSize: 'var(--ema-code-font-size, 13px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ema-font-mono, monospace)',
    lineHeight: 'var(--ema-code-line-height, 1.6)',
    maxHeight: 'var(--ema-code-max-height, min(60vh, 36rem))',
    overflow: 'auto',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ema-syntax-comment, var(--ema-text-tertiary))',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--ema-primary-muted)',
  },
});

const highlighting = HighlightStyle.define([
  { tag: tags.string, color: 'var(--ema-syntax-string, var(--ema-syntax-text))' },
  { tag: tags.propertyName, color: 'var(--ema-syntax-key, var(--ema-syntax-text))' },
  { tag: tags.number, color: 'var(--ema-syntax-number, var(--ema-syntax-text))' },
  { tag: [tags.bool, tags.null], color: 'var(--ema-syntax-boolean, var(--ema-syntax-text))' },
]);

function codeSyntax(source: string, language: string): Extension {
  if (language === 'json') return json();
  if (language === 'text' || !hljs.getLanguage(language)) return [];

  // 只解析高亮器生成的转义文本和 span, 不把原始代码作为 HTML 放入页面.
  // 装饰保留 CodeMirror 的单一滚动区域和可视区渲染.
  const template = document.createElement('template');
  template.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
  const ranges: Range<Decoration>[] = [];
  let offset = 0;

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return;
    }
    const start = offset;
    for (const child of node.childNodes) visit(child);
    if (node instanceof HTMLElement && node.className && start < offset) {
      ranges.push(Decoration.mark({ class: node.className }).range(start, offset));
    }
  }

  visit(template.content);
  return EditorView.decorations.of(Decoration.set(ranges, true));
}

export const CodeViewer = memo(function CodeViewer({
  source,
  language = 'text',
  lineNumbers,
  embedded = false,
  wrapLines = true,
}: CodeViewerProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const displayedSource = useRef('');
  const syntax = useMemo(() => new Compartment(), []);
  const wrapping = useMemo(() => new Compartment(), []);
  const gutter = useMemo(() => new Compartment(), []);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  useLayoutEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({
          tabindex: '0',
          'aria-label': '只读文本',
          'aria-readonly': 'true',
        }),
        keymap.of(standardKeymap),
        drawSelection(),
        // 横纵滚动由同一个可视区负责, 长文档无需滚到底才能横向查看.
        wrapping.of([]),
        appearance,
        syntaxHighlighting(highlighting),
        syntax.of([]),
        gutter.of([]),
      ],
    });
    editor.current = view;
    displayedSource.current = '';
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [syntax, wrapping, gutter]);

  useLayoutEffect(() => {
    const view = editor.current!;
    const effects = syntax.reconfigure(codeSyntax(source, language));
    if (displayedSource.current !== source) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        effects,
      });
      displayedSource.current = source;
    } else {
      view.dispatch({ effects });
    }
  }, [source, language, syntax]);

  useLayoutEffect(() => {
    editor.current!.dispatch({
      effects: gutter.reconfigure(lineNumbers ? codeLineNumbers({
        formatNumber: number => lineNumbers[number - 1] ?? '',
      }) : []),
    });
  }, [lineNumbers, gutter]);

  useLayoutEffect(() => {
    editor.current!.dispatch({ effects: wrapping.reconfigure(wrapLines ? EditorView.lineWrapping : []) });
  }, [wrapLines, wrapping]);

  useEffect(() => {
    setCopyStatus('idle');
    return () => clearTimeout(copyTimer.current);
  }, [source]);

  const copy = async (): Promise<void> => {
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(source);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
    copyTimer.current = setTimeout(() => setCopyStatus('idle'), 2500);
  };

  return (
    <div className={embedded
      ? 'ema-code-viewer ema-code-viewer--embedded min-w-0'
      : 'ema-code-viewer ema-material-code min-w-0 overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-syntax-bg)]'}>
      {!embedded && (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--ema-border)] px-3 py-1">
          <span className="text-xs text-[var(--ema-text-tertiary)]">
            {language === 'text' ? '文本' : language.toUpperCase()} · 只读
          </span>
          <div className="flex items-center gap-2">
            <span role="status" className="text-xs text-[var(--ema-text-secondary)]">
              {copyStatus === 'copied' && '已复制'}
              {copyStatus === 'failed' && '复制失败,请重试'}
            </span>
            <Tooltip content={copyStatus === 'copied' ? '已复制' : '复制全文'}>
              <IconButton
                shape="rounded"
                variant="ghost"
                size="sm"
                label="复制全文"
                icon={copyStatus === 'copied' ? 'i-lucide:check' : 'i-lucide:copy'}
                onClick={() => void copy()}
              />
            </Tooltip>
          </div>
        </div>
      )}
      <div ref={host} />
    </div>
  );
});
