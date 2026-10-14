import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { standardKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { Button } from './Button.js';

export interface CodeViewerProps {
  /** 完整文本. 可视区只显示其中一部分, 复制全文不受可视区限制. */
  readonly source: string;
  readonly language?: 'json' | 'text';
}

const appearance = EditorView.theme({
  '&': {
    color: 'var(--ema-syntax-text, var(--ema-text-primary))',
    backgroundColor: 'transparent',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ema-font-mono, monospace)',
    lineHeight: '1.6',
    maxHeight: 'min(60vh, 36rem)',
    overflow: 'auto',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 12px' },
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

export const CodeViewer = memo(function CodeViewer({ source, language = 'text' }: CodeViewerProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const displayedSource = useRef('');
  const syntax = useMemo(() => new Compartment(), []);
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
        // 固定可视区高度后由 CodeMirror 处理滚动, 包括折行后的超长 JSON 字符串.
        EditorView.lineWrapping,
        appearance,
        syntaxHighlighting(highlighting),
        syntax.of([]),
      ],
    });
    editor.current = view;
    displayedSource.current = '';
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [syntax]);

  useLayoutEffect(() => {
    const view = editor.current!;
    if (displayedSource.current !== source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
      displayedSource.current = source;
    }
  }, [source]);

  useLayoutEffect(() => {
    editor.current!.dispatch({ effects: syntax.reconfigure(language === 'json' ? json() : []) });
  }, [language, syntax]);

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
    <div className="ema-code-viewer ema-material-code min-w-0 overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-syntax-bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ema-border)] px-3 py-1">
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          {language === 'json' ? 'JSON' : '文本'} · 只读
        </span>
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs text-[var(--ema-text-secondary)]">
            {copyStatus === 'copied' && '已复制'}
            {copyStatus === 'failed' && '复制失败，请重试'}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            复制全文
          </Button>
        </div>
      </div>
      <div ref={host} />
    </div>
  );
});
